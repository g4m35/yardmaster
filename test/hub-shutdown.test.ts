import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { sandbox } from './helpers.ts';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

for (const phase of ['react', 'heartbeat'] as const) test(`hub shutdown joins an admitted ${phase} before callers may close the database`, { timeout: 10_000 }, async () => {
  const box = sandbox();
  const hub = new Hub({ db: openDb(join(box.home, 'shutdown.db')), token: 'fixture', machineId: 'm-shutdown',
    port: 0, host: '127.0.0.1', quiet: true, includeMock: false, tickMs: phase === 'heartbeat' ? 10 : 60_000 });
  const entered = latch(); const resume = latch(); const returned = latch();
  let stopping: Promise<void> | undefined;
  try {
    await hub.start();
    if (phase === 'react') {
      const tick = hub.worker.tick.bind(hub.worker);
      hub.worker.tick = async () => { entered.release(); await resume.promise; try { await tick(); } finally { returned.release(); } };
      hub.kick();
    } else {
      const info = await hub.worker.info();
      hub.worker.info = async () => { entered.release(); await resume.promise; returned.release(); return info; };
    }
    await entered.promise;
    let stopped = false;
    stopping = hub.stop().then(() => { stopped = true; });
    await setImmediate();
    assert.equal(stopped, false, 'stop must wait for the admitted callback, which still owns database work');
    resume.release();
    await stopping;
    hub.coord.db.close();
    // An unjoined callback would now attempt its database work after the documented stop boundary.
    await setImmediate();
  } finally {
    resume.release();
    await (stopping ?? hub.stop());
    await returned.promise;
    await setImmediate();
    if (hub.coord.db.isOpen) hub.coord.db.close();
  }
});
