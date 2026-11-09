import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { planCleanup, runCleanup } from '../src/janitor.ts';
import { sandbox, sh } from './helpers.ts';

test('cleanup planning survives a merged branch disappearing after enumeration and keeps other work', async () => {
  const box = sandbox({ cleanup: { auto: false } }); const db = openDb(':memory:'); const coord = new Coordinator(db);
  const oldPath = process.env.PATH;
  try {
    const project = await coord.registerProject(box.repo);
    const [gone, remaining] = coord.addTasks(project.id, [{ title: 'Already tidied branch' }, { title: 'Still merged branch' }], 'fixture').created;
    const branch = `yardmaster/${gone!.id}`;
    sh(box.repo, 'git', ['branch', 'yardmaster/integration']);
    for (const task of [gone!, remaining!]) {
      sh(box.repo, 'git', ['branch', `yardmaster/${task.id}`]);
      coord.updateTask(task.id, { status: 'done', branch: `yardmaster/${task.id}` });
    }
    sh(box.repo, 'git', ['branch', 'yardmaster/user-owned']);
    const realGit = (oldPath ?? '').split(delimiter).map(dir => join(dir, 'git')).find(path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
    assert.ok(realGit);
    const bin = join(box.root, 'bin'); mkdirSync(bin);
    const injected = join(box.root, 'deleted-before-tip-read');
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const ref = ${JSON.stringify('refs/heads/' + branch)};
if (args[0] === 'rev-parse' && args.some(x => x === ref || x === ref + '^{commit}') && !existsSync(${JSON.stringify(injected)})) {
  const removed = spawnSync(${JSON.stringify(realGit)}, ['update-ref', '-d', ref], { stdio: 'inherit' });
  if (removed.status !== 0) process.exit(98);
  writeFileSync(${JSON.stringify(injected)}, 'deleted');
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    process.env.PATH = bin + delimiter + oldPath;
    const plan = await planCleanup(coord, project.id, { sizes: false });
    assert.ok(existsSync(injected), 'delete must occur at the final tip read, after successful ancestry');
    assert.ok(!plan.remove.some(item => item.kind === 'branch' && item.target === branch));
    assert.ok(plan.remove.some(item => item.kind === 'branch' && item.target === `yardmaster/${remaining!.id}`), 'planning continues for the other merged task');
    assert.ok(plan.keep.some(item => item.target === 'yardmaster/user-owned'));
    const result = await runCleanup(coord, plan);
    assert.equal(result.failed.length, 0);
    assert.ok(sh(box.repo, 'git', ['show-ref', '--verify', 'refs/heads/yardmaster/user-owned']));
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    db.close(); rmSync(box.root, { recursive: true, force: true });
  }
});
