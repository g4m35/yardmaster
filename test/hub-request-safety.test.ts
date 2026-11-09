import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
import { sandbox } from './helpers.ts';

test('malformed unauthenticated targets and rejected handlers do not terminate the hub', { timeout: 20000 }, async () => {
  const box = sandbox();
  const mod = (file: string) => JSON.stringify(pathToFileURL(join(import.meta.dirname, file)).href);
  const code = `import {Hub} from ${mod('../src/hub.ts')}; import {openDb} from ${mod('../src/db.ts')};
const h=new Hub({db:openDb(${JSON.stringify(join(box.home, 'req.db'))}),token:'fixture',machineId:'m-request',port:0,host:'127.0.0.1',quiet:true,includeMock:false,tickMs:60000});
const original=h.handle.bind(h); h.handle=(req,res)=>req.url==='/rejected-handler'?Promise.reject(new Error('private failure details')):original(req,res);
await h.start();process.send(h.url);process.on('message',async()=>{await h.stop();h.coord.db.close();process.exit(0)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const ended = once(child, 'exit');
  let errors = ''; child.stderr!.on('data', d => { errors += d; });
  try {
    const [value] = await once(child, 'message');
    const url = new URL(String(value));
    const raw = (target: string) => new Promise<string>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname);
      let result = '';
      socket.setTimeout(3000, () => socket.destroy(new Error('request timed out')));
      socket.on('connect', () => socket.end(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
      socket.on('data', data => { result += data; }); socket.on('error', reject); socket.on('end', () => resolve(result));
    });
    assert.match(await raw('http://['), /^HTTP\/1\.1 400/);
    assert.equal((await fetch(`${url}api/health`)).status, 200);
    const rejected = await fetch(`${url}rejected-handler`);
    assert.equal(rejected.status, 500);
    assert.ok(!(await rejected.text()).includes('private failure details'));
    assert.equal((await fetch(`${url}api/health`)).status, 200);
    assert.equal(child.exitCode, null, errors);
    child.send('stop');
    assert.equal((await ended)[0], 0, errors);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await ended; }
    rmSync(box.root, { recursive: true, force: true });
  }
});
