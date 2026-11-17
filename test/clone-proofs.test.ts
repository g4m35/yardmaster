import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cloneDependency } from '../src/dependency-disk.ts';
import { sandbox, afterChanges } from './helpers.ts';

test('source proofs left by a dead process are removed, live and unrelated entries are kept', async () => {
  const box = sandbox(); const source = join(box.repo, 'node_modules'); const state = join(box.home, 'clone-proofs');
  fs.mkdirSync(source); fs.writeFileSync(join(source, 'package'), 'x');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const entries = { dead: `source-${dead}-AbC123`, legacy: 'source-XyZ789', live: 'source-1-QwE456', other: 'keep-me' };
  for (const name of Object.values(entries)) { fs.mkdirSync(join(state, name), { recursive: true }); fs.writeFileSync(join(state, name, 'started'), ''); }
  await afterChanges(source);
  const target = join(box.root, 'worktrees', 'a', 'node_modules');
  await cloneDependency(source, target, async () => {
    fs.cpSync(source, target, { recursive: true });
    return { ok: true, method: 'cp-reflink', ms: 0 };
  });
  const left = fs.readdirSync(state);
  assert.ok(!left.includes(entries.dead), 'a dead owner\'s proof is removed');
  assert.ok(!left.includes(entries.legacy), 'a proof without an owner pid is removed');
  assert.ok(left.includes(entries.live), 'a live owner\'s proof is kept');
  assert.ok(left.includes(entries.other), 'entries that are not source proofs are kept');
  assert.ok(left.some(name => name.startsWith(`source-${process.pid}-`)), 'the new proof names its owner');
});
