import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { SQLInputValue } from 'node:sqlite';
import { EventStream } from '../src/event-stream.ts';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import type { YardEvent } from '../src/types.ts';

class Response extends EventEmitter {
  destroyed = false;
  blocked = false;
  frames: string[] = [];
  writeHead() {}
  write(frame: string) { this.frames.push(frame); return !this.blocked; }
  end() { this.destroyed = true; this.emit('close'); }
  response() { return this as unknown as ServerResponse; }
}

function fixture(t: TestContext, count = 1) {
  const db = openDb(':memory:');
  const coord = new Coordinator(db);
  let polls = 0;
  const prepare = db.prepare.bind(db);
  t.mock.method(db, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (sql.includes('FROM events WHERE')) {
      const all = statement.all.bind(statement);
      t.mock.method(statement, 'all', (...params: SQLInputValue[]) => { polls++; return all(...params); });
    }
    return statement;
  });
  const add = (id: number) => coord.event(null, null, 'info', 'fixture', 'event ' + id, { id });
  for (let id = 1; id <= count; id++) add(id);
  const stream = new EventStream(db);
  t.after(() => { stream.close(); db.close(); });
  return { stream, add, polls: () => polls };
}

test('one SQLite event poll serves multiple clients and stops when the last connection closes', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { stream, add, polls } = fixture(t);
  const first = new Response(); const second = new Response();
  stream.connect(first.response(), 0); stream.connect(second.response(), 0);
  add(2); t.mock.timers.tick(700);
  assert.equal(polls(), 1);
  assert.equal(first.frames[1], second.frames[1]);
  assert.match(first.frames[1]!, /event 2/);
  assert.deepEqual((JSON.parse(first.frames[1]!.slice(6)) as YardEvent[])[0]!.data, { id: 2 });
  first.end(); t.mock.timers.tick(700);
  assert.equal(polls(), 2);
  second.end(); t.mock.timers.tick(1400);
  assert.equal(polls(), 2);
});

test('backpressure pauses all writes until drain without blocking fast clients or losing replay', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { stream, add, polls } = fixture(t);
  const slow = new Response(); const fast = new Response();
  slow.blocked = true;
  stream.connect(slow.response(), 0); stream.connect(fast.response(), 0);
  add(2); t.mock.timers.tick(2100);
  assert.equal(slow.frames.length, 1, 'no events or keepalives while hello is backpressured');
  assert.equal(polls(), 3);
  assert.match(fast.frames[1]!, /event 2/);
  slow.blocked = false; slow.emit('drain'); t.mock.timers.tick(700);
  assert.match(slow.frames[1]!, /event 2/);
  slow.blocked = true;
  add(3); t.mock.timers.tick(700);
  const size = slow.frames.length;
  add(4); t.mock.timers.tick(700);
  assert.equal(slow.frames.length, size);
  assert.match(fast.frames.at(-1)!, /event 4/);
  fast.end();
  const count = polls(); t.mock.timers.tick(1400);
  assert.equal(polls(), count, 'no database work when every client is backpressured');
  slow.blocked = false; slow.emit('drain'); t.mock.timers.tick(700);
  assert.match(slow.frames.at(-1)!, /event 4/);
  assert.doesNotMatch(slow.frames.at(-1)!, /event 3/);
  stream.close();
  assert.equal(slow.destroyed, true);
  assert.equal(slow.listenerCount('drain'), 0);
  const late = new Response(); stream.connect(late.response(), 0);
  assert.equal(late.destroyed, true, 'shutdown refuses new streams');
  const closedPolls = polls(); t.mock.timers.tick(1400); assert.equal(polls(), closedPolls);
});

test('450 real coordinator events replay in bounded oldest-first pages to clients with different cursors', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { stream, polls } = fixture(t, 450);
  const old = new Response(); const recent = new Response();
  stream.connect(old.response(), 1); stream.connect(recent.response(), 400);
  t.mock.timers.tick(2100);
  assert.equal(polls(), 6, 'each distinct replay cursor gets its own bounded read');
  const batches = (res: Response) => res.frames.filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)) as YardEvent[]);
  assert.ok(batches(old).every(batch => batch.length <= 200));
  assert.deepEqual(batches(old).flatMap(batch => batch.map(e => e.id)), Array.from({ length: 449 }, (_, i) => i + 2));
  assert.deepEqual(batches(recent).flatMap(batch => batch.map(e => e.id)), Array.from({ length: 50 }, (_, i) => i + 401));
});

test('shared stream invalidates silent snapshots every 30 seconds, including after drain', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { stream, polls } = fixture(t);
  const first = new Response(); const second = new Response(); const slow = new Response();
  slow.blocked = true;
  stream.connect(first.response(), 0); stream.connect(second.response(), 0); stream.connect(slow.response(), 0);
  t.mock.timers.tick(29_400);
  assert.equal(first.frames.some(frame => frame.includes('event: refresh')), false);
  const previous = polls(); t.mock.timers.tick(700);
  assert.equal(polls(), previous + 1, 'invalidation needs no additional database poll');
  assert.equal(first.frames.filter(frame => frame.includes('event: refresh')).length, 1);
  assert.equal(second.frames.filter(frame => frame.includes('event: refresh')).length, 1);
  assert.equal(slow.frames.length, 1);
  slow.blocked = false; slow.emit('drain'); t.mock.timers.tick(700);
  assert.match(slow.frames.at(-1)!, /event: refresh/);
});

test('a caught-up client receives the next live event even while another replays a large backlog', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { stream, add, polls } = fixture(t, 450);
  const behind = new Response(); const live = new Response();
  stream.connect(behind.response(), 1); stream.connect(live.response(), 450);
  add(451); t.mock.timers.tick(700);
  assert.match(live.frames.at(-1)!, /event 451/, 'history replay cannot hold up the live frontier');
  assert.ok(polls() <= 2, 'each cursor group gets at most one bounded read');
  const batch = JSON.parse(behind.frames[1]!.slice(6)) as YardEvent[];
  assert.equal(batch.length, 200);
  assert.equal(batch[0]!.id, 2);
});
