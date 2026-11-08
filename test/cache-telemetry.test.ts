import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claude, codex, gemini, opencode } from '../src/adapters/builtin.ts';
import type { Adapter, AgentEvent } from '../src/adapters/types.ts';
import { buildMethods, localClient } from '../src/api.ts';
import { Coordinator } from '../src/coordinator.ts';
import { openDb } from '../src/db.ts';
import { buildRegistry } from '../src/registry.ts';
import { UsageMeter, type UsageSnapshot } from '../src/usage.ts';

// Local CLI output fixtures only: no provider, subprocess, filesystem checkout or model invocation.
const price = { inPerM: 3, outPerM: 15, cachedInPerM: 0.3 };
type Usage = Extract<AgentEvent, { type: 'usage' }>;
function parsedUsage(adapter: Adapter, line: unknown): Usage {
  const events = adapter.parse(JSON.stringify(line)).filter((event): event is Usage => event.type === 'usage');
  assert.equal(events.length, 1, `${adapter.name} emits one usage event for the fixture`);
  return events[0]!;
}

function fixture(agent: string) {
  const db = openDb(':memory:');
  const now = Date.now();
  db.prepare('INSERT INTO projects (id,name,root,base_branch,created_at) VALUES (?,?,?,?,?)')
    .run('p-cache', 'cache fixture', '/fixture/cache-telemetry', 'main', now);
  db.prepare(`INSERT INTO tasks (id,project_id,title,prompt,fingerprint,status,tier,max_attempts,
    created_by,created_at,updated_at,machine_id,assignee,generation,lease_until)
    VALUES ('t-cache','p-cache','cache fixture','fixture','cache','running','standard',3,
    'fixture',?,?,'m-cache','machine:m-cache',1,?)`).run(now, now, now + 60_000);
  db.prepare(`INSERT INTO runs (id,task_id,machine_id,generation,attempt,agent,status,started_at,role)
    VALUES ('r-cache','t-cache','m-cache',1,1,?,'running',?,'implement')`).run(agent, now);
  const coord = new Coordinator(db);
  const client = localClient(buildMethods(coord, { machineId: 'm-hub' }));
  const identity = { runId: 'r-cache', taskId: 't-cache', owner: { generation: 1, assignee: 'machine:m-cache' } };
  const persist = (usage: UsageSnapshot, sequence = 1) => client['run.usage']({ ...identity, sequence, usage });
  function check(snapshot: UsageSnapshot, expectedRead: number | null, sequence = 1) {
    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(identity.runId)!;
    assert.equal(row.cache_read_tokens, expectedRead, 'run persistence preserves the cache counter presence');
    assert.equal(row.cache_write_tokens, snapshot.cacheWriteTokens);
    assert.equal(row.usage_seq, sequence);
    assert.equal(row.usage_provenance, snapshot.provenance);
    assert.equal(row.tokens_in, snapshot.tokensIn);
    assert.equal(row.tokens_out, snapshot.tokensOut);
    const ledger = db.prepare(`SELECT COUNT(*) AS count, SUM(tokens_in_delta) AS tokens_in,
      SUM(tokens_out_delta) AS tokens_out FROM usage_ledger WHERE run_id = ?`).get(identity.runId)!;
    assert.equal(ledger.count, sequence, 'the fenced API wrote each absolute snapshot once');
    assert.equal(ledger.tokens_in, snapshot.tokensIn);
    assert.equal(ledger.tokens_out, snapshot.tokensOut);
    const entry = buildRegistry(db, { projectId: 'p-cache', now }).entries.find(e => e.runId === identity.runId)!;
    assert.ok(entry, 'the persisted run is projected into the registry');
    assert.deepEqual(entry.cache, { readTokens: expectedRead, writeTokens: snapshot.cacheWriteTokens });
    assert.equal(entry.usage!.provenance, snapshot.provenance);
    assert.equal(entry.usage!.tokensIn, snapshot.tokensIn);
    assert.equal(entry.usage!.tokensOut, snapshot.tokensOut);
  }
  return { db, client, identity, persist, check };
}

const reportingAdapters = [
  { adapter: claude, line: (read?: number) => ({ type: 'assistant', message: { id: 'message-cache', usage: {
    input_tokens: 1000, output_tokens: 100, ...(read === undefined ? {} : { cache_read_input_tokens: read }),
  } } }) },
  { adapter: codex, line: (read?: number) => ({ type: 'turn.completed', usage: {
    input_tokens: 1000, output_tokens: 100, ...(read === undefined ? {} : { cached_input_tokens: read }),
  } }) },
  { adapter: opencode, line: (read?: number) => ({ type: 'step_finish', part: { tokens: {
    input: 1000, output: 100, ...(read === undefined ? {} : { cache: { read } }),
  } } }) },
];

for (const { adapter, line } of reportingAdapters) {
  for (const read of [undefined, 0, 240]) {
    test(`${adapter.name}: ${read === undefined ? 'omitted' : read === 0 ? 'explicit zero' : 'positive'} cache reads survive parser → meter → fenced API → DB → registry`, async () => {
      const event = parsedUsage(adapter, line(read));
      assert.equal(Object.hasOwn(event, 'cachedIn'), read !== undefined, 'the adapter does not manufacture a counter');
      assert.equal(event.cachedIn, read);
      const meter = new UsageMeter(price);
      meter.add(event);
      const snapshot = meter.snapshot();
      assert.equal(snapshot.cacheReadTokens, read ?? null);
      assert.equal(snapshot.cacheWriteTokens, null);
      assert.equal(snapshot.provenance, 'estimated', 'measured token totals do not imply cache telemetry');
      assert.equal(snapshot.tokensIn, adapter === codex ? 1000 : 1000 + (read ?? 0));
      const f = fixture(adapter.name);
      try {
        await f.persist(snapshot);
        f.check(snapshot, read ?? null);
      } finally { f.db.close(); }
    });
  }
}

test('Gemini normal successful result leaves cache reads unknown despite measured input/output usage', async () => {
  const event = parsedUsage(gemini, { type: 'result', status: 'success', stats: { input_tokens: 1000, output_tokens: 100 } });
  assert.equal(Object.hasOwn(event, 'cachedIn'), false);
  const meter = new UsageMeter(price);
  meter.add(event);
  const snapshot = meter.snapshot();
  assert.equal(snapshot.cacheReadTokens, null);
  assert.equal(snapshot.tokensIn, 1000);
  assert.equal(snapshot.tokensOut, 100);
  assert.equal(snapshot.provenance, 'estimated');
  assert.ok(snapshot.costUsd > 0, 'unknown cache telemetry does not erase token-based spend');
  const f = fixture(gemini.name);
  try {
    await f.persist(snapshot);
    f.check(snapshot, null);
  } finally { f.db.close(); }
});

for (const read of [undefined, 0, 240]) {
  test(`Claude cumulative finals omitting cache reads preserve ${read === undefined ? 'unknown' : read === 0 ? 'explicit zero' : 'the earlier counter'} through the usage ledger`, async () => {
    const meter = new UsageMeter(price);
    meter.add(parsedUsage(claude, reportingAdapters[0]!.line(read)));
    const f = fixture(claude.name);
    try {
      await f.persist(meter.snapshot());
      const final = (input: number, cost: number) => parsedUsage(claude, { type: 'result', subtype: 'success',
        total_cost_usd: cost, usage: { input_tokens: input, output_tokens: 200 } });
      for (const sequence of [2, 3]) {
        const event = final(1000 * sequence, sequence / 10);
        assert.equal(Object.hasOwn(event, 'cachedIn'), false);
        assert.equal(event.cumulative, true);
        meter.add(event);
        const snapshot = meter.snapshot();
        assert.equal(snapshot.cacheReadTokens, read ?? null, 'omission preserves the prior observation, including zero');
        assert.equal(snapshot.provenance, 'actual', 'a final dollar figure does not create cache telemetry');
        assert.equal(snapshot.costUsd, sequence / 10);
        await f.persist(snapshot, sequence);
        f.check(snapshot, read ?? null, sequence);
      }
    } finally { f.db.close(); }
  });
}

test('an explicit cumulative zero supersedes a prior positive cache count; forged or replayed snapshots cannot alter it', async () => {
  const meter = new UsageMeter(price);
  meter.add(parsedUsage(claude, reportingAdapters[0]!.line(240)));
  const f = fixture(claude.name);
  try {
    const earlier = meter.snapshot();
    await f.persist(earlier);
    meter.add(parsedUsage(claude, { type: 'result', subtype: 'success', total_cost_usd: .2,
      usage: { input_tokens: 2000, output_tokens: 200, cache_read_input_tokens: 0 } }));
    const snapshot = meter.snapshot();
    assert.equal(snapshot.cacheReadTokens, 0, 'explicit zero is an observation rather than omission');
    await f.persist(snapshot, 2);
    await f.persist(earlier, 1);
    await f.persist(earlier, 2);
    await assert.rejects(f.client['run.usage']({ ...f.identity, sequence: 3, usage: earlier,
      owner: { ...f.identity.owner, generation: 2 } }), /recorded run identity/);
    await assert.rejects(f.client['run.usage']({ ...f.identity, sequence: 3, usage: earlier,
      owner: { ...f.identity.owner, assignee: 'machine:m-other' } }), /recorded run identity/);
    f.check(snapshot, 0, 2);
  } finally { f.db.close(); }
});
