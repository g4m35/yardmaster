import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.ts';
import { openDb } from '../src/db.ts';
import { Coordinator } from '../src/coordinator.ts';
import { buildMethods, dispatch } from '../src/api.ts';
import { changeSince } from '../src/git.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
type Diff = { source: string | null; files: { path: string; added: number | null; removed: number | null }[]; patch: string; truncated: boolean; note: string | null };

test('the owner reads a task change: the saved artifact once it exists, its working copy while it runs', async () => {
  const box = sandbox({ review: { mode: 'never' } });
  const db = openDb(join(box.home, 'task-diff.sqlite'));
  try {
    const coord = new Coordinator(db), project = await coord.registerProject(box.repo);
    const methods = buildMethods(coord, { machineId: 'hub-fixture' });
    mkdirSync(join(box.repo, 'src'), { recursive: true });
    writeFileSync(join(box.repo, 'src', 'keep.ts'), 'one\ntwo\n');
    writeFileSync(join(box.repo, 'src', 'old name.ts'), 'moved\n');
    git(box.repo, 'add', '-A'); git(box.repo, 'commit', '-qm', 'base');
    const base = git(box.repo, 'rev-parse', 'HEAD');
    const [task] = coord.addTasks(project.id, [{ title: 'Diff fixture', agent: 'mock' }], 'test', { force: true }).created;
    assert.equal((await dispatch(methods, 'task.diff', { id: task!.id }) as Diff).note, 'Nothing changed yet. The change appears here once an agent starts.');

    // While it runs: tracked edits in its working copy, compared with where it started.
    const copy = join(box.home, 'copy');
    git(box.repo, 'worktree', 'add', '-q', '-b', 'yardmaster/diff', copy, base);
    writeFileSync(join(copy, 'src', 'keep.ts'), 'one\nTWO\n');
    coord.updateTask(task!.id, { status: 'running', base_sha: base, worktree: copy });
    const live = await dispatch(methods, 'task.diff', { id: task!.id }) as Diff;
    assert.equal(live.source, 'working copy');
    assert.deepEqual(live.files, [{ path: 'src/keep.ts', added: 1, removed: 1 }]);
    assert.match(live.patch, /^-two\n\+TWO$/m);

    // Once saved: the exact commit approval would merge, including renames, new and binary files.
    git(copy, 'mv', 'src/old name.ts', 'src/new name.ts');
    writeFileSync(join(copy, 'src', 'logo.bin'), Buffer.from([0, 1, 2, 0, 255]));
    git(copy, 'add', '-A'); git(copy, 'commit', '-qm', 'work');
    const head = git(copy, 'rev-parse', 'HEAD');
    writeFileSync(join(copy, 'src', 'keep.ts'), 'unsaved edit\n');
    coord.updateTask(task!.id, { status: 'ready', head_sha: head });
    const saved = await dispatch(methods, 'task.diff', { id: task!.id }) as Diff;
    assert.equal(saved.source, 'artifact');
    assert.deepEqual(saved.files, [
      { path: 'src/keep.ts', added: 1, removed: 1 },
      { path: 'src/logo.bin', added: null, removed: null },
      { path: 'src/new name.ts', added: 0, removed: 0 },
    ]);
    assert.doesNotMatch(saved.patch, /unsaved edit/);

    // A long change is cut at a line boundary and says so.
    const cut = await changeSince(box.repo, base, head, 40);
    assert.equal(cut.truncated, true);
    assert.ok(cut.patch.length <= 40 && !cut.patch.endsWith('\n'));

    // Neither a working copy nor objects on this hub: say where the change is instead of failing.
    rmSync(copy, { recursive: true, force: true });
    coord.updateTask(task!.id, { status: 'running', head_sha: 'f'.repeat(40) });
    assert.match((await dispatch(methods, 'task.diff', { id: task!.id }) as Diff).note!, /^This hub cannot read the change/);
    await assert.rejects(dispatch(methods, 'task.diff', { id: 't-missing' }), /No task t-missing/);
    // Workers can write these fields; a value Git would read as an option is refused before Git runs.
    const target = join(box.home, 'written-by-git');
    coord.updateTask(task!.id, { status: 'ready', base_sha: `--output=${target}`, head_sha: head });
    assert.match((await dispatch(methods, 'task.diff', { id: task!.id }) as Diff).note!, /Not a commit id: --output=/);
    await assert.rejects(changeSince(box.repo, base, '--output=x'), /Not a commit id/);
    assert.equal(existsSync(target), false);
  } finally { db.close(); }
});
