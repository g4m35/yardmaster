import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.ts';
import { Coordinator } from '../src/coordinator.ts';
import { buildMethods, dispatch } from '../src/api.ts';
import { PairingStore, authorizeWorkerRpc, authorizeWorkerBaseBundle } from '../src/pairing.ts';
import { connectWorker, fleetClient, joinFleet, loadWorkerCredential, normalizeHubUrl, saveWorkerCredential, workerCredentialPath } from '../src/fleet-client.ts';
import { sandbox, until } from './helpers.ts';

const cliFile = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const owner = { kind: 'owner' as const, ownerId: 'personal' };
const ownerToken = 'fixture-owner-secret-never-shared';

function environment(box: ReturnType<typeof sandbox>): NodeJS.ProcessEnv {
  // Child commands never see the real native homes or inherited hub/provider configuration.
  const env = { ...process.env, HOME: box.home, USERPROFILE: box.home, CODEX_HOME: join(box.home, '.codex'), CLAUDE_CONFIG_DIR: join(box.home, '.claude'), XDG_CONFIG_HOME: join(box.home, '.config'), YARDMASTER_HOME: box.home, NO_COLOR: '1' };
  for (const key of ['YARDMASTER_HUB', 'YARDMASTER_TOKEN', 'YARDMASTER_TASK_ID', 'YARDMASTER_RUN_ID', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete env[key];
  return env;
}
function startCli(box: ReturnType<typeof sandbox>, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [cliFile, ...args], { cwd: box.repo, env: { ...environment(box), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done, output: () => stdout + stderr };
}
async function cli(box: ReturnType<typeof sandbox>, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const run = startCli(box, args, extra);
  const timer = setTimeout(() => run.child.kill('SIGTERM'), 15_000);
  try { return await run.done; } finally { clearTimeout(timer); }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
}

/** Fake network boundary, real durable PairingStore/auth/dispatch; no Hub background loops or providers. */
async function fakeHub() {
  const box = sandbox({ disk: { minFreeGb: 0, maxWorktreesGb: null } });
  chmodSync(box.home, 0o700);
  const db = openDb(join(box.home, 'fixture.db'));
  const coord = new Coordinator(db);
  const project = await coord.registerProject(box.repo);
  const store = new PairingStore(db, { ownerId: owner.ownerId });
  const methods = buildMethods(coord, { machineId: 'hub-fixture' });
  const calls: { name: string; params: Record<string, unknown>; worker: boolean; allowed: boolean }[] = [];
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const params = JSON.parse(raw || '{}');
      if (req.url === '/api/pair') {
        assert.equal(req.headers.authorization, undefined, 'pair redemption must not exchange an owner token');
        try { return send(200, { ok: true, result: store.redeemInvitation(params.code, params.machineId) }); }
        catch { return send(403, { ok: false, error: 'Pairing code invalid, expired, revoked or already used.' }); }
      }
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const isOwner = token === ownerToken;
      const worker = isOwner ? null : store.authenticate(token);
      if (!isOwner && !worker) return send(401, { ok: false, error: 'Missing, revoked, expired or wrong credential. Pair again.' });
      const name = req.url?.replace('/api/rpc/', '') ?? '';
      if (name === 'fleet.identity') {
        if (worker) authorizeWorkerBaseBundle(coord, worker, worker.projectId);
        return send(200, { ok: true, result: worker ? { kind: 'worker', projectId: worker.projectId, machineId: worker.machineId, expiresAt: worker.expiresAt } : { kind: 'owner' } });
      }
      const call = { name, params, worker: !!worker, allowed: false }; calls.push(call);
      try {
        if (worker) authorizeWorkerRpc(coord, worker, name, params);
        call.allowed = true;
        return send(200, { ok: true, result: await dispatch(methods, name, params) ?? null });
      } catch (err) { return send(200, { ok: false, error: (err as Error).message }); }
    } catch { send(500, { ok: false, error: 'Fixture request failure' }); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const hub = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { box, db, coord, project, store, calls, hub,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); } };
}

test('hub endpoints are canonical, private by default and cannot embed secrets', () => {
  assert.equal(normalizeHubUrl('HTTPS://Hub.EXAMPLE:443/'), 'https://hub.example');
  assert.equal(normalizeHubUrl('https://hub.example/prefix///'), 'https://hub.example/prefix');
  for (const url of ['http://localhost:7777', 'http://127.0.0.2:7777/', 'http://[::1]:7777']) assert.ok(normalizeHubUrl(url));
  assert.equal(normalizeHubUrl('http://10.0.0.2:7777/', { privateNetwork: true }), 'http://10.0.0.2:7777');
  for (const url of ['ftp://hub', 'file:///tmp/hub', 'hub:7777', 'https://user:secret@hub', 'https://@hub', 'https://hub?token=secret', 'https://hub?', 'https://hub#token', 'https://hub#', 'https://hub/\\evil', ' https://hub', 'http://hub', 'http://localhost.evil', 'http://10.0.0.2']) assert.throws(() => normalizeHubUrl(url), url);
  assert.throws(() => normalizeHubUrl('https://user:secret@hub', { privateNetwork: true }));
});

test('pair -> private saved credential -> real worker heartbeat/claim -> revoke refuses reconnect', { timeout: 30_000 }, async () => {
  const f = await fakeHub(); let worker: ReturnType<typeof startCli> | undefined;
  try {
    const invitation = await cli(f.box, ['pair', 'invite', '--project', f.project.id, '--hub', f.hub, '--json'], { YARDMASTER_TOKEN: ownerToken });
    assert.equal(invitation.code, 0, invitation.stderr);
    const invite = JSON.parse(invitation.stdout);
    assert.match(invite.code, /^ymi_/); assert.ok(!invitation.stdout.includes(ownerToken));
    const joined = await cli(f.box, ['pair', 'join', invite.code, '--hub', `${f.hub}/`, '--project', f.project.id]);
    assert.equal(joined.code, 0, joined.stderr); assert.match(joined.stdout, /saved privately/);
    const id = readFileSync(join(f.box.home, 'machine-id'), 'utf8').trim();
    const saved = loadWorkerCredential(f.hub, f.project.id, id);
    assert.ok(!joined.stdout.includes(saved.token)); assert.ok(!joined.stdout.includes(invite.code)); assert.ok(!existsSync(join(f.box.home, 'token')));
    const file = workerCredentialPath(f.hub, f.project.id);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.box.home, 'worker-credentials')).mode & 0o777, 0o700);
    assert.equal(statSync(f.box.home).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(join(f.box.home, 'worker-credentials')), [file.split('/').pop()]);
    const replay = await cli(f.box, ['pair', 'join', invite.code, '--hub', f.hub]);
    assert.equal(replay.code, 1); assert.match(replay.stderr, /already used/);
    const channel = await connectWorker({ hub: `${f.hub}/`, projectIds: [f.project.id], machineId: id });
    await assert.rejects(channel.client['project.resolve']({ projectId: f.project.id }), /denied/);
    await assert.rejects(channel.client['registry.list']({}), /denied/);
    await assert.rejects(channel.client['task.list']({ projectId: 'p-other' }), /denied/);
    worker = startCli(f.box, ['worker', '--hub', f.hub, '--repo', f.box.repo]);
    await until(() => f.calls.some(c => c.name === 'worker.claim' && c.worker && c.allowed), Boolean, 12_000, 'scoped CLI worker claim');
    for (const call of f.calls.filter(c => c.worker && ['worker.claim', 'machine.heartbeat'].includes(c.name))) {
      const repos = call.name === 'worker.claim' ? call.params.repos : (call.params.info as { repos: unknown }).repos;
      assert.deepEqual(Object.keys(repos as object), [f.project.id]);
      assert.equal(call.params[call.name === 'worker.claim' ? 'machineId' : 'id'], id);
    }
    assert.ok(f.calls.some(c => c.name === 'task.list' && c.worker && c.allowed));
    assert.ok(!worker.output().includes(saved.token));
    const listed = await cli(f.box, ['pair', 'list', '--hub', f.hub, '--json'], { YARDMASTER_TOKEN: ownerToken });
    assert.equal(listed.code, 0, listed.stderr); const devices = JSON.parse(listed.stdout);
    assert.equal(devices.credentials[0].machineId, id); assert.ok(!listed.stdout.includes(saved.token));
    const revoked = await cli(f.box, ['pair', 'revoke', devices.credentials[0].id, '--hub', f.hub], { YARDMASTER_TOKEN: ownerToken });
    assert.equal(revoked.code, 0, revoked.stderr);
    const allowedClaims = f.calls.filter(c => c.name === 'worker.claim' && c.allowed).length;
    await until(() => worker!.output().includes('revoked'), Boolean, 6000, 'running worker refuses revoked heartbeat');
    assert.equal(f.calls.filter(c => c.name === 'worker.claim' && c.allowed).length, allowedClaims);
    await stop(worker.child); const stopped = await worker.done; assert.equal(stopped.code, 0, stopped.stderr); worker = undefined;
    await assert.rejects(channel.client['task.list']({ projectId: f.project.id }), /revoked/);
    const denied = await cli(f.box, ['worker', '--hub', f.hub, '--repo', f.box.repo]);
    assert.equal(denied.code, 1); assert.match(denied.stderr, /revoked/); assert.ok(!denied.stderr.includes(saved.token));
    assert.ok(!existsSync(join(f.box.home, 'token')), 'never manufacture a local owner fallback');
  } finally { if (worker) { await stop(worker.child); await worker.done; } await f.close(); }
});

test('credentials reject unknown, expired, changed identity and multi-project channels; explicit owner remains privileged', async () => {
  const f = await fakeHub();
  try {
    const machineId = 'm-test';
    await assert.rejects(connectWorker({ hub: f.hub, projectIds: [f.project.id], machineId }), /No saved worker credential/);
    await assert.rejects(connectWorker({ hub: f.hub, projectIds: [f.project.id], machineId, token: 'unknown-token' }), /wrong credential/);
    const { code } = f.store.createInvitation(owner, { projectId: f.project.id });
    await joinFleet({ hub: f.hub, code, machineId });
    const saved = loadWorkerCredential(f.hub, f.project.id, machineId);
    await assert.rejects(connectWorker({ hub: f.hub, projectIds: [f.project.id], machineId, token: 'unknown-token' }), /wrong credential/);
    await assert.rejects(connectWorker({ hub: f.hub, projectIds: [f.project.id, 'p-other'], machineId }), /one project/);
    await assert.rejects(connectWorker({ hub: f.hub, projectIds: [f.project.id, 'p-other'], machineId, token: saved.token }), /one different/);
    await assert.rejects(connectWorker({ hub: f.hub, projectIds: [f.project.id], machineId: 'm-other', token: saved.token }), /bound/);
    await assert.rejects(connectWorker({ hub: f.hub, projectIds: ['p-other'], machineId, token: saved.token }), /bound/);
    const badExplicit = await cli(f.box, ['worker', '--hub', f.hub, '--token', 'unknown-token', '--repo', f.box.repo]);
    assert.equal(badExplicit.code, 1); assert.match(badExplicit.stderr, /wrong credential/);
    const legacy = await connectWorker({ hub: f.hub, projectIds: [f.project.id, 'p-other'], machineId, token: ownerToken });
    assert.equal(legacy.identity.kind, 'owner');
    const ownerWorker = startCli(f.box, ['worker', '--hub', f.hub, '--token', ownerToken, '--repo', f.box.repo]);
    try {
      await until(() => ownerWorker.output().includes(' joined '), Boolean, 6000, 'legacy owner worker startup');
      assert.match(ownerWorker.output(), /Privileged legacy owner channel/);
      assert.ok(!ownerWorker.output().includes(ownerToken));
    } finally { await stop(ownerWorker.child); await ownerWorker.done; }
    const listed = await cli(f.box, ['pair', 'list', '--hub', f.hub], { YARDMASTER_TOKEN: saved.token });
    assert.equal(listed.code, 1); assert.match(listed.stderr, /owner access/);
    const file = workerCredentialPath(f.hub, f.project.id);
    writeFileSync(file, JSON.stringify({ ...saved, expiresAt: Date.now() - 1 }));
    assert.throws(() => loadWorkerCredential(f.hub, f.project.id, machineId), /unexpired/);
    writeFileSync(file, JSON.stringify({ ...saved, hub: 'https://another.example' }));
    assert.throws(() => loadWorkerCredential(f.hub, f.project.id, machineId), /does not match/);
    writeFileSync(file, JSON.stringify({ ...saved, token: ownerToken }));
    assert.throws(() => loadWorkerCredential(f.hub, f.project.id, machineId), /does not match/);
    writeFileSync(file, '{broken'); assert.throws(() => loadWorkerCredential(f.hub, f.project.id, machineId), /Invalid saved/);
  } finally { await f.close(); }
});

test('credential storage fails closed for public permissions, oversized files and symlinks', async () => {
  const f = await fakeHub();
  try {
    const joined = await joinFleet({ hub: f.hub, code: f.store.createInvitation(owner, { projectId: f.project.id }).code, machineId: 'm-test' });
    const saved = loadWorkerCredential(f.hub, f.project.id, 'm-test'); const file = joined.file;
    assert.equal(workerCredentialPath(`${f.hub}/`, f.project.id), file);
    assert.notEqual(workerCredentialPath('https://another.example', f.project.id), file);
    assert.notEqual(workerCredentialPath(f.hub, 'p-other'), file);
    chmodSync(file, 0o644); assert.throws(() => loadWorkerCredential(f.hub, f.project.id, 'm-test'), /Unsafe/);
    assert.throws(() => saveWorkerCredential(saved), /Unsafe/); chmodSync(file, 0o600);
    writeFileSync(file, 'x'.repeat(8193)); assert.throws(() => loadWorkerCredential(f.hub, f.project.id, 'm-test'), /Unsafe/);
    unlinkSync(file); const target = join(f.box.home, 'untouched'); writeFileSync(target, 'do not overwrite', { mode: 0o600 }); symlinkSync(target, file);
    assert.throws(() => loadWorkerCredential(f.hub, f.project.id, 'm-test'), /Unsafe/);
    assert.throws(() => saveWorkerCredential(saved), /Unsafe/); assert.equal(readFileSync(target, 'utf8'), 'do not overwrite');
    unlinkSync(file); chmodSync(join(f.box.home, 'worker-credentials'), 0o755);
    assert.throws(() => saveWorkerCredential(saved), /Unsafe/); chmodSync(join(f.box.home, 'worker-credentials'), 0o700);
    chmodSync(f.box.home, 0o755); assert.throws(() => saveWorkerCredential(saved), /Unsafe/); chmodSync(f.box.home, 0o700);
    assert.throws(() => saveWorkerCredential({ ...saved, token: ownerToken }), /non-worker/);
    const directory = join(f.box.home, 'worker-credentials');
    rmdirSync(directory); const otherDirectory = join(f.box.home, 'other-credentials'); mkdirSync(otherDirectory, { mode: 0o700 }); symlinkSync(otherDirectory, directory);
    assert.throws(() => saveWorkerCredential(saved), /Unsafe/); assert.deepEqual(readdirSync(otherDirectory), []);
  } finally { await f.close(); }
});

test('expired and revoked invitations cannot join; failed scope validation saves nothing', async () => {
  const f = await fakeHub();
  try {
    const expired = f.store.createInvitation(owner, { projectId: f.project.id });
    f.db.prepare('UPDATE fleet_invitations SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.invitation.id);
    await assert.rejects(joinFleet({ hub: f.hub, code: expired.code, machineId: 'm-test' }), /expired/);
    const revoked = f.store.createInvitation(owner, { projectId: f.project.id });
    const revoke = await cli(f.box, ['pair', 'revoke', revoked.invitation.id, '--hub', f.hub, '--invitation'], { YARDMASTER_TOKEN: ownerToken });
    assert.equal(revoke.code, 0, revoke.stderr);
    await assert.rejects(joinFleet({ hub: f.hub, code: revoked.code, machineId: 'm-test' }), /revoked/);
    const mismatch = f.store.createInvitation(owner, { projectId: f.project.id });
    await assert.rejects(joinFleet({ hub: f.hub, code: mismatch.code, machineId: 'm-test', projectId: 'p-other' }), /scope does not match/);
    assert.deepEqual(readdirSync(join(f.box.home, 'worker-credentials')), []);
    const aliasInvite = f.store.createInvitation(owner, { projectId: f.project.id });
    const alias = join(f.box.root, 'symlink-home'); symlinkSync(f.box.home, alias);
    const beforeMachine = existsSync(join(f.box.home, 'machine-id'));
    const deniedAlias = await cli(f.box, ['pair', 'join', aliasInvite.code, '--hub', f.hub], { YARDMASTER_HOME: alias });
    assert.equal(deniedAlias.code, 1); assert.match(deniedAlias.stderr, /Unsafe/);
    assert.equal(existsSync(join(f.box.home, 'machine-id')), beforeMachine);
    assert.equal(f.store.redeemInvitation(aliasInvite.code, 'm-test').identity.machineId, 'm-test');
    const valid = f.store.createInvitation(owner, { projectId: f.project.id });
    chmodSync(f.box.home, 0o755);
    await assert.rejects(joinFleet({ hub: f.hub, code: valid.code, machineId: 'm-test' }), /Unsafe/);
    chmodSync(f.box.home, 0o700);
    assert.equal(f.store.redeemInvitation(valid.code, 'm-test').identity.machineId, 'm-test', 'unsafe storage must not consume invitation');
  } finally { await f.close(); }
});

test('pairing and bearer RPC reject redirects instead of forwarding secrets', async () => {
  const box = sandbox(); chmodSync(box.home, 0o700);
  let redirected = 0;
  const server = createServer((req, res) => {
    if (req.url === '/leak') { redirected++; res.end('{}'); }
    else { res.writeHead(307, { location: '/leak' }); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const hub = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await assert.rejects(joinFleet({ hub, code: 'ymi_' + 'a'.repeat(43), machineId: 'm-test' }), /fetch failed/);
    await assert.rejects(fleetClient(hub, ownerToken)['fleet.identity']({}), /fetch failed/);
    assert.equal(redirected, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('CLI help, dry setup, first-run setup and doctor use isolated homes and preserve native choices', { timeout: 30_000 }, async () => {
  const f = await fakeHub();
  try {
    const help = await cli(f.box, ['help']); assert.equal(help.code, 0); assert.match(help.stdout, /ym setup/); assert.match(help.stdout, /ym pair invite/); assert.match(help.stdout, /ym worker/);
    const before = readFileSync(join(f.box.repo, 'yardmaster.json'), 'utf8');
    const dry = await cli(f.box, ['setup', '--agent', 'codex', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr); assert.match(dry.stdout, /Setup plan/);
    assert.equal(readFileSync(join(f.box.repo, 'yardmaster.json'), 'utf8'), before);
    assert.ok(!existsSync(join(f.box.home, '.codex'))); assert.ok(!existsSync(join(f.box.home, '.claude')));
    const noChoice = await cli(f.box, ['setup']); assert.equal(noChoice.code, 0, noChoice.stderr); assert.match(noChoice.stdout, /No native client settings changed/); assert.match(noChoice.stdout, /ym connect codex --dry-run/);
    assert.ok(!existsSync(join(f.box.home, '.codex'))); assert.ok(!existsSync(join(f.box.home, '.claude')));
    const bad = await cli(f.box, ['setup', '--agent', 'invalid']); assert.equal(bad.code, 1);
    const setup = await cli(f.box, ['setup', '--agent', 'cursor', '--no-skill', '--no-hooks']);
    assert.equal(setup.code, 0, setup.stderr); assert.ok(existsSync(join(f.box.home, '.cursor', 'mcp.json')));
    assert.ok(!existsSync(join(f.box.home, '.codex'))); assert.ok(!existsSync(join(f.box.home, '.claude')));
    const doctor = await cli(f.box, ['doctor', '--hub', f.hub], { YARDMASTER_TOKEN: ownerToken });
    assert.equal(doctor.code, 0, doctor.stderr); assert.match(doctor.stdout, /Registry coverage/); assert.match(doctor.stdout, /managed=0/); assert.match(doctor.stdout, /verify/); assert.match(doctor.stdout, /unknown/); assert.match(doctor.stdout, /required review policy/);
    writeFileSync(join(f.box.home, 'config.json'), JSON.stringify({ agents: { codex: { minimumEffort: 'high', effort: { cheap: 'low' } } } }));
    const policy = await cli(f.box, ['doctor', '--hub', f.hub], { YARDMASTER_TOKEN: ownerToken });
    assert.equal(policy.code, 0); assert.match(policy.stdout, /below minimumEffort/);
    const unsafe = await cli(f.box, ['worker', '--hub', 'http://untrusted.example', '--token', 'secret']); assert.equal(unsafe.code, 1); assert.match(unsafe.stderr, /private-network/);
    const token = await cli(f.box, ['token']); assert.equal(token.code, 0); assert.match(token.stdout, /Privileged owner token/); assert.match(token.stdout, /ym pair invite/); assert.ok(!token.stdout.includes('--token '));
    assert.equal(readFileSync(join(f.box.repo, 'yardmaster.json'), 'utf8'), before);
  } finally { await f.close(); }
});

test('fresh setup writes a detected project config without selecting or changing a native client', async () => {
  const box = sandbox();
  unlinkSync(join(box.repo, 'yardmaster.json'));
  const result = await cli(box, ['setup', '--agent', 'none']);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(join(box.repo, 'yardmaster.json')));
  assert.match(result.stdout, /Wrote yardmaster.json/);
  for (const clientHome of ['.claude', '.codex', '.cursor', '.gemini', '.config']) assert.ok(!existsSync(join(box.home, clientHome)));
});

test('join refuses a token whose authenticated identity differs from the redemption scope', async () => {
  const box = sandbox(); chmodSync(box.home, 0o700);
  const expiresAt = Date.now() + 60_000;
  const identity = { kind: 'worker', machineId: 'm-test', projectId: 'p-test', expiresAt };
  let asOwner = false;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain fixture request before responding. */ }
    const result = req.url === '/api/pair'
      ? { token: 'ymw_' + 'a'.repeat(43), identity, credential: identity }
      : asOwner ? { kind: 'owner' } : { ...identity, machineId: 'm-other' };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const hub = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await assert.rejects(joinFleet({ hub, code: 'ymi_' + 'a'.repeat(43), machineId: 'm-test' }), /identity changed/);
    asOwner = true;
    await assert.rejects(joinFleet({ hub, code: 'ymi_' + 'a'.repeat(43), machineId: 'm-test' }), /worker identity/);
    assert.deepEqual(readdirSync(join(box.home, 'worker-credentials')), []);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
