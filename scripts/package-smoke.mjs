import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'ym-package-smoke-'));
const node = process.env.YM_SMOKE_NODE || process.execPath;
function command(cmd, args, cwd, env = {}) {
  const result = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000 });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
try {
  const [{ filename }] = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], process.cwd()));
  const install = join(root, 'install'); mkdirSync(install);
  writeFileSync(join(install, 'package.json'), '{"private":true}');
  command('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(root, filename)], install);
  const packageRoot = join(install, 'node_modules/yardmaster');
  const cli = join(packageRoot, 'dist/cli.js');
  const env = { YARDMASTER_HOME: join(root, 'private-home'), YARDMASTER_HUB: '', YARDMASTER_TOKEN: '' };
  mkdirSync(env.YARDMASTER_HOME, { mode: 0o700 });
  const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'))).version;
  assert.equal(command(node, [cli, '--version'], install, env).trim(), version);
  assert.match(command(node, [cli, '--help'], install, env), /Yardmaster|yardmaster/);
  assert.ok(existsSync(join(packageRoot, 'dist/dashboard/index.html')), 'dashboard asset packaged');
  const doctor = command(node, [cli, 'doctor'], install, env);
  assert.match(doctor, /Node.js 22.16\+/);
  assert.match(doctor, /Cost coverage:/);
  console.log(JSON.stringify({ kind: 'package-smoke', version, node: command(node, ['--version'], install).trim(),
    checks: ['tarball install', 'version', 'help', 'dashboard asset', 'doctor without personal hub'], result: 'pass' }));
} finally { rmSync(root, { recursive: true, force: true }); }
