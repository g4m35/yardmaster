import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { sandbox } from './helpers.ts';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

for (const phase of ['react', 'heartbeat', 'pressure'] as const) test(`hub shutdown joins an admitted ${phase} before callers may close the database`, { timeout: 10_000 }, async () => {
  const box = sandbox(phase === 'pressure' ? { disk: { minFreeGb: 1e9, maxWorktreesGb: null } } : {});
  const hub = new Hub({ db: openDb(join(box.home, 'shutdown.db')), token: 'fixture', machineId: 'm-shutdown',
    port: 0, host: '127.0.0.1', quiet: true, includeMock: false, tickMs: phase === 'heartbeat' ? 10 : 60_000 });
  const entered = latch(); const resume = latch(); const returned = latch();
  const tickReturned = latch();
  let pressureCalls = 0;
  let stopping: Promise<void> | undefined;
  try {
    await hub.start();
    if (phase === 'react') {
      const tick = hub.worker.tick.bind(hub.worker);
      hub.worker.tick = async () => { entered.release(); await resume.promise; try { await tick(); } finally { returned.release(); } };
      hub.kick();
    } else if (phase === 'heartbeat') {
      const info = await hub.worker.info();
      hub.worker.info = async () => { entered.release(); await resume.promise; returned.release(); return info; };
    } else {
      const tick = hub.worker.tick.bind(hub.worker);
      hub.worker.tick = async () => { try { await tick(); } finally { tickReturned.release(); } };
      // Keep the real disk-pressure admission path; suspend only the cleanup body.
      (hub as unknown as { relieveDisk(): Promise<void> }).relieveDisk = async () => {
        pressureCalls++; entered.release(); await resume.promise; returned.release();
      };
      hub.kick();
    }
    await entered.promise;
    if (phase === 'pressure') await tickReturned.promise;
    let stopped = false;
    stopping = hub.stop().then(() => { stopped = true; });
    await setImmediate();
    assert.equal(stopped, false, 'stop must wait for the admitted callback, which still owns database work');
    resume.release();
    await stopping;
    if (phase === 'pressure') {
      await (hub.worker as unknown as { onDiskPressure(): Promise<void> }).onDiskPressure();
      assert.equal(pressureCalls, 1, 'shutdown refuses new disk-pressure cleanup');
    }
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

test('a failing background error logger surfaces its failure instead of disappearing', async () => {
  const source = (file: string) => pathToFileURL(join(import.meta.dirname, file)).href;
  const script = `import {Hub} from ${JSON.stringify(source('../src/hub.ts'))};
import {openDb} from ${JSON.stringify(source('../src/db.ts'))};
import {sandbox} from ${JSON.stringify(source('./helpers.ts'))};
const box=sandbox(); const hub=new Hub({db:openDb(box.home+'/logger.db'),token:'fixture',machineId:'m-logger',port:0,host:'127.0.0.1',quiet:true,tickMs:60000,includeMock:false});
let timer; let handler; let observed=null;
try {await hub.start();
const loud=new Promise(resolve=>{handler=error=>{observed=String(error);resolve(true)};process.on('unhandledRejection',handler)});
const event=hub.coord.event.bind(hub.coord);hub.coord.event=(...args)=>{if(args[3]==='hub.error')throw new Error('LOGGER-FAILURE-SENTINEL');return event(...args)};
hub.worker.tick=async()=>{throw new Error('fixture scheduling failure')};hub.kick();
await Promise.race([loud,new Promise(resolve=>{timer=setTimeout(resolve,1500)})]);
}finally{clearTimeout(timer);await hub.stop();hub.coord.db.close();if(handler)process.off('unhandledRejection',handler)}
console.log(JSON.stringify({observed}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  let output = ''; let errors = '';
  child.stdout!.on('data', data => { output += data; }); child.stderr!.on('data', data => { errors += data; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, errors);
  assert.match(JSON.parse(output).observed ?? '', /LOGGER-FAILURE-SENTINEL/);
});
