import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Hub } from '../src/hub.ts';
import { openDb } from '../src/db.ts';
import { Coordinator } from '../src/coordinator.ts';
import { resolveConfig } from '../src/config.ts';
import { verifyArtifact } from '../src/verification.ts';
import { sandbox, sh, settleTasks } from './helpers.ts';

for (const scenario of ['no checks', 'unavailable reviewer', 'blocking review', 'explicit advisory review'] as const) {
  test(`acceptance: ${scenario}`, { timeout: 30000 }, async () => {
    const box = sandbox({ review: { mode: scenario === 'no checks' ? 'never' : 'always',
      reviewers: scenario === 'unavailable reviewer' ? [] : ['mock'], crossFamily: false, maxRounds: 0,
      ...(scenario === 'explicit advisory review' ? { onUnresolved: 'proceed' } : {}) } });
    if (scenario === 'no checks') {
      writeFileSync(join(box.repo, 'yardmaster.json'), JSON.stringify({ verify: [] }));
      sh(box.repo, 'git', ['add', 'yardmaster.json']); sh(box.repo, 'git', ['commit', '-qm', 'empty verification']);
    }
    const h = new Hub({ db: openDb(join(box.home, 'accept.db')), token:'fixture', machineId:'m-accept', port:0,host:'127.0.0.1',quiet:true,includeMock:true,tickMs:100 });
    try {
      await h.start(); const p = await h.coord.registerProject(box.repo);
      const prompt = '@mock write result.js content\n@mock-review 0 changes Handle missing input';
      const t = h.coord.addTasks(p.id, [{title:`Acceptance scenario ${scenario}`,prompt,files:['result.js'],agent:'mock'}], 'test').created[0]!;
      const [done] = await settleTasks(h.coord, [t.id], box.root, 25000);
      assert.equal(done!.status, scenario === 'explicit advisory review' ? 'done' : 'needs_human', done!.attention ?? '');
      if (scenario !== 'explicit advisory review') {
        assert.ok(done!.worktree && existsSync(done!.worktree), 'unaccepted work stays available');
        assert.notEqual(sh(box.repo, 'git', ['rev-parse','yardmaster/integration']), done!.head_sha);
      }
      if (scenario === 'no checks') assert.match(done!.attention!, /verification commands/);
      else if (scenario === 'unavailable reviewer') assert.match(done!.attention!, /review did not complete/);
      else if (scenario === 'blocking review') assert.match(done!.attention!, /still has concerns/);
    } finally { await h.stop(); h.coord.db.close(); rmSync(box.root, {recursive:true,force:true}); }
  });
}

test('empty artifact verification is not a successful check and review remains selective by default', async () => {
  const box=sandbox();
  try {
    assert.equal((await verifyArtifact(box.repo, [], 1)).ok, false);
    const c=resolveConfig([]);assert.equal(c.review.mode,'auto');assert.equal(c.review.required,false);assert.equal(c.review.onUnresolved,'needs_human');
  } finally {rmSync(box.root,{recursive:true,force:true});}
});

test('native code cannot finish by report alone; explicit report-only tasks can', async () => {
  const box=sandbox();const db=openDb(':memory:');const c=new Coordinator(db);
  try {
    const p=await c.registerProject(box.repo);
    const [code,report]=c.addTasks(p.id,[{title:'Implement a code change'},{title:'Research repository conventions',allowNoChanges:true}],'test').created;
    const owned=c.claimForSession('session:code',p.id,code!.id)!;
    assert.throws(()=>c.finishForSession(owned.assignee!,owned.id,'claimed completion','done',undefined,owned.generation),/committed branch submission/);
    assert.equal(c.getTask(owned.id)!.status,'running');
    const research=c.claimForSession('session:report',p.id,report!.id)!;
    assert.equal(c.finishForSession(research.assignee!,research.id,'research findings','done',undefined,research.generation).status,'done');
  } finally {db.close();rmSync(box.root,{recursive:true,force:true});}
});
