import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { EventStream } from '../src/event-stream.ts';
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
function event(id: number): YardEvent {
  return { id, project_id: null, task_id: null, level: 'info', kind: 'fixture', message: 'event ' + id, data: null, ts: id };
}

test('one event poll serves multiple clients and stops when the last connection closes', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const events: YardEvent[] = [event(1)];
  let polls = 0;
  const stream = new EventStream({ lastEventId: () => events.at(-1)!.id,
    eventsSince: after => { polls++; return events.filter(e => e.id > after).slice(0, 200); } });
  const first = new Response(); const second = new Response();
  try {
    stream.connect(first.response(), 0); stream.connect(second.response(), 0);
    events.push(event(2));
    t.mock.timers.tick(700);
    assert.equal(polls, 1);
    assert.equal(first.frames[1], second.frames[1]);
    assert.match(first.frames[1]!, /event 2/);
    first.end();
    t.mock.timers.tick(700);
    assert.equal(polls, 2);
    second.end();
    t.mock.timers.tick(1400);
    assert.equal(polls, 2);
  } finally { stream.close(); }
});

test('backpressure pauses all writes to a slow client until drain without blocking fast clients or losing replay', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const events = [event(1)];
  let polls = 0;
  const stream = new EventStream({ lastEventId: () => 1,
    eventsSince: after => { polls++; return events.filter(e => e.id > after).slice(0, 200); } });
  const slow = new Response(); const fast = new Response();
  try {
    slow.blocked = true;
    stream.connect(slow.response(), 0); stream.connect(fast.response(), 0);
    events.push(event(2));
    t.mock.timers.tick(2100);
    assert.equal(slow.frames.length, 1, 'no events or keepalives while hello is backpressured');
    assert.equal(polls, 3);
    assert.match(fast.frames[1]!, /event 2/);
    slow.blocked = false; slow.emit('drain');
    t.mock.timers.tick(700);
    assert.match(slow.frames[1]!, /event 2/);
    slow.blocked = true;
    events.push(event(3)); t.mock.timers.tick(700);
    const size = slow.frames.length;
    events.push(event(4)); t.mock.timers.tick(700);
    assert.equal(slow.frames.length, size);
    assert.match(fast.frames.at(-1)!, /event 4/);
    fast.end();
    const count = polls; t.mock.timers.tick(1400);
    assert.equal(polls, count, 'no database work when every client is backpressured');
    slow.blocked = false; slow.emit('drain'); t.mock.timers.tick(700);
    assert.match(slow.frames.at(-1)!, /event 4/);
    assert.doesNotMatch(slow.frames.at(-1)!, /event 3/);
    stream.close();
    assert.equal(slow.destroyed, true);
    assert.equal(slow.listenerCount('drain'), 0);
    const late = new Response(); stream.connect(late.response(), 0);
    assert.equal(late.destroyed, true, 'shutdown refuses new streams');
    const closedPolls = polls; t.mock.timers.tick(1400); assert.equal(polls, closedPolls);
  } finally { stream.close(); }
});

test('clients with different replay cursors share bounded reads and receive each event once in order', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const events = Array.from({ length: 450 }, (_, i) => event(i + 1));
  let polls = 0;
  const stream = new EventStream({ lastEventId: () => 450,
    eventsSince: (after, _, limit) => { polls++; assert.equal(limit, 200); return events.filter(e => e.id > after).slice(0, limit); } });
  const old = new Response(); const recent = new Response();
  try {
    stream.connect(old.response(), 1); stream.connect(recent.response(), 400);
    t.mock.timers.tick(2100);
    assert.equal(polls, 3);
    const ids = (res: Response) => res.frames.filter(frame => frame.startsWith('data: ')).flatMap(frame =>
      (JSON.parse(frame.slice(6)) as YardEvent[]).map(e => e.id));
    assert.deepEqual(ids(old), events.slice(1).map(e => e.id));
    assert.deepEqual(ids(recent), events.slice(400).map(e => e.id));
  } finally { stream.close(); }
});

test('shared stream invalidates silent machine/session snapshots every 30 seconds, including after drain', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  let polls = 0;
  const stream = new EventStream({ lastEventId: () => 1, eventsSince: () => { polls++; return []; } });
  const first = new Response(); const second = new Response(); const slow = new Response();
  slow.blocked = true;
  try {
    stream.connect(first.response(), 0); stream.connect(second.response(), 0); stream.connect(slow.response(), 0);
    t.mock.timers.tick(29_400);
    assert.equal(first.frames.some(frame => frame.includes('event: refresh')), false);
    const previous = polls;
    t.mock.timers.tick(700);
    assert.equal(polls, previous + 1, 'invalidation needs no additional database poll');
    assert.equal(first.frames.filter(frame => frame.includes('event: refresh')).length, 1);
    assert.equal(second.frames.filter(frame => frame.includes('event: refresh')).length, 1);
    assert.equal(slow.frames.length, 1);
    slow.blocked = false; slow.emit('drain'); t.mock.timers.tick(700);
    assert.match(slow.frames.at(-1)!, /event: refresh/);
  } finally { stream.close(); }
});
