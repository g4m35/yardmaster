import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferTier } from '../src/router.ts';
import { hookPlan } from '../src/connect.ts';

test('risk forms take precedence over cheap wording', () => {
  for (const word of ['concurrency', 'concurrent', 'migration', 'migrations', 'migrate', 'migrating', 'vulnerability', 'vulnerabilities', 'optimization', 'optimisation', 'optimize', 'optimizing', 'deadlocks']) {
    assert.equal(inferTier(`Fix ${word} typo`), 'strong', word);
  }
  assert.equal(inferTier('Fix wording in documentation'), 'cheap');
  assert.equal(inferTier('Document the concurrentness of this fictional word'), 'standard');
});

test('generated Codex edit hook configuration dispatches apply_patch before and after', () => {
  const plan = hookPlan('codex');
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const entries = plan.hooks[event] as { matcher: string; hooks: { command: string }[] }[];
    for (const name of ['apply_patch', 'Edit', 'Write', 'file_change']) {
      assert.ok(entries.some((e) => new RegExp(e.matcher).test(name) && e.hooks.length > 0), `${event} ${name}`);
    }
    assert.ok(!entries.some((e) => new RegExp(e.matcher).test('Read')));
  }
});
