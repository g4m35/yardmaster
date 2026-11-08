import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, runShell, withProcessScope } from '../src/proc.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, until } from './helpers.ts';

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const split = `const out=Buffer.from('é€😀'); const err=Buffer.from('文🦊');let i=0;
const timer=setInterval(()=>{if(i<out.length)process.stdout.write(out.subarray(i,i+1));
if(i<err.length)process.stderr.write(err.subarray(i,i+1));if(++i>=Math.max(out.length,err.length))clearInterval(timer);},5);`;

test('scoped utilities stream-decode separate stdout/stderr across every UTF-8 byte boundary', async () => {
  const expected = await run(process.execPath, ['-e', split]);
  const actual = await withProcessScope({}, () => run(process.execPath, ['-e', split]));
  assert.equal(actual.stdout, 'é€😀'); assert.equal(actual.stderr, '文🦊');
  assert.deepEqual(actual, expected);
});

test('unscoped utilities with stdin also preserve split UTF-8 output', async () => {
  const result = await run(process.execPath, ['-e', split], { input: 'fixture input' });
  assert.equal(result.stdout, 'é€😀'); assert.equal(result.stderr, '文🦊');
});

test('utility decoders flush an incomplete final sequence once on nonzero exit', async () => {
  const code = "process.stdout.write(Buffer.from([0xe2,0x82]));process.stderr.write(Buffer.from([0xf0,0x9f]));process.exitCode=7";
  const actual = await withProcessScope({}, () => run(process.execPath, ['-e', code]));
  assert.equal(actual.code, 7); assert.equal(actual.stdout, '�'); assert.equal(actual.stderr, '�');
});

test('shell verification keeps independent UTF-8 decoders for interleaved output', async () => {
  const actual = await runShell(`${quote(process.execPath)} -e ${quote(split)}`, { cwd: process.cwd(), timeoutMs: 5000 });
  assert.equal(actual.code, 0); assert.equal(actual.reaped, true);
  assert.equal(actual.stdout.includes('�'), false);
  for (const char of 'é€😀文🦊') assert.equal(actual.stdout.includes(char), true, char);
});

test('shell cancellation flushes pending bytes after reaping its process', async () => {
  const abort = new AbortController();
  const ready = join(tempDir('ym-utf8-'), 'ready');
  const code = `process.stdout.write(Buffer.from([0xe2,0x82]));require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`;
  const running = runShell(`${quote(process.execPath)} -e ${quote(code)}`, { cwd: process.cwd(), timeoutMs: 5000, signal: abort.signal });
  try {
    await until(() => existsSync(ready), value => value, 5000, 'partial UTF-8 output ready');
    abort.abort('fixture cancellation');
    const result = await running;
    assert.equal(result.aborted, true); assert.equal(result.reaped, true); assert.equal(result.stdout.startsWith('�'), true);
  } finally { abort.abort('fixture finished'); await running; }
});

test('bounded shell output retains a valid Unicode tail', async () => {
  const code = "process.stdout.write('😀x'.repeat(200000)+'Z')";
  const result = await runShell(`${quote(process.execPath)} -e ${quote(code)}`, { cwd: process.cwd(), timeoutMs: 5000 });
  assert.equal(result.code, 0); assert.equal(result.reaped, true); assert.ok(result.stdout.length <= 400_000);
  assert.equal(result.stdout.endsWith('Z'), true); assert.equal(result.stdout.includes('�'), false);
  assert.equal(/[\uD800-\uDFFF]/u.test(result.stdout), false, 'truncation never leaves an unpaired surrogate');
});
