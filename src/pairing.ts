import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { tx } from './transaction.ts';
import type { Coordinator, ClaimOwner } from './coordinator.ts';
import type { Task, Run } from './types.ts';
import { WORKER_ACTIVE_STATUSES, WORKER_FINALIZE_STATUSES } from './worker-policy.ts';

/** Append to db.ts MIGRATIONS. Constructors and request handlers never create tables. */
export const migrationDDL = `
CREATE TABLE fleet_invitations (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  credential_ttl_ms INTEGER NOT NULL, redeemed_at INTEGER, revoked_at INTEGER
);
CREATE INDEX fleet_invitations_owner ON fleet_invitations(owner_id, created_at DESC);
CREATE TABLE fleet_credentials (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT NOT NULL, machine_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX fleet_credentials_owner ON fleet_credentials(owner_id, created_at DESC);
`;

export interface OwnerIdentity { kind: 'owner'; ownerId: string }
/** Construct only from authenticate(), never from request JSON. This is a bearer principal, not a sandbox. */
export interface WorkerIdentity {
  kind: 'worker'; credentialId: string; ownerId: string; projectId: string; machineId: string; expiresAt: number;
}
export interface InvitationMetadata {
  id: string; ownerId: string; projectId: string; createdAt: number; expiresAt: number;
  redeemedAt: number | null; revokedAt: number | null;
}
export interface CredentialMetadata {
  id: string; ownerId: string; projectId: string; machineId: string; createdAt: number;
  expiresAt: number; revokedAt: number | null;
}
interface InvitationRow {
  id: string; owner_id: string; project_id: string; code_hash: string; created_at: number;
  expires_at: number; credential_ttl_ms: number; redeemed_at: number | null; revoked_at: number | null;
}
interface CredentialRow {
  id: string; owner_id: string; project_id: string; machine_id: string; token_hash: string;
  created_at: number; expires_at: number; revoked_at: number | null;
}
const DAY = 86_400_000;
function fail(): never { throw new Error('Worker access denied'); }
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}$/.test(value)) fail();
  return value;
}
function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail();
  return value;
}
function timestamp(value: number): number { return integer(value, 0); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function equal(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function secret(value: unknown, prefix: 'ymi_' | 'ymw_'): string | null {
  return typeof value === 'string' && value.length === 47 && value.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}
function metadata(row: CredentialRow): CredentialMetadata {
  return { id: row.id, ownerId: row.owner_id, projectId: row.project_id, machineId: row.machine_id,
    createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at };
}
function invitationMetadata(row: InvitationRow): InvitationMetadata {
  return { id: row.id, ownerId: row.owner_id, projectId: row.project_id, createdAt: row.created_at,
    expiresAt: row.expires_at, redeemedAt: row.redeemed_at, revokedAt: row.revoked_at };
}
function identity(row: CredentialRow): WorkerIdentity {
  return { kind: 'worker', credentialId: row.id, ownerId: row.owner_id, projectId: row.project_id,
    machineId: row.machine_id, expiresAt: row.expires_at };
}

/** One trusted personal owner. The HTTP layer must authenticate the owner before passing OwnerIdentity.
 * Requires private HTTPS/overlay transport. Does not isolate a malicious user with this OS account/DB access.
 */
export class PairingStore {
  private readonly db: Db;
  private readonly ownerId: string;
  private readonly now: () => number;
  constructor(db: Db, options: { ownerId: string; now?: () => number }) {
    this.db = db; this.ownerId = id(options.ownerId); this.now = options.now ?? Date.now;
  }
  private owner(actor: OwnerIdentity): void {
    if (actor?.kind !== 'owner' || typeof actor.ownerId !== 'string' || !equal(id(actor.ownerId), this.ownerId)) fail();
  }
  createInvitation(actor: OwnerIdentity, options: { projectId: string; ttlMs?: number; credentialTtlMs?: number }): { code: string; invitation: InvitationMetadata } {
    this.owner(actor);
    const projectId = id(options.projectId);
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) fail();
    const now = timestamp(this.now());
    const ttl = integer(options.ttlMs ?? 10 * 60_000, 1000, DAY);
    const credentialTtl = integer(options.credentialTtlMs ?? 90 * DAY, 1000, 365 * DAY);
    const code = `ymi_${randomBytes(32).toString('base64url')}`;
    const row: InvitationRow = { id: `invite-${randomUUID()}`, owner_id: this.ownerId, project_id: projectId,
      code_hash: hash(code), created_at: now, expires_at: timestamp(now + ttl), credential_ttl_ms: credentialTtl, redeemed_at: null, revoked_at: null };
    this.db.prepare(`INSERT INTO fleet_invitations
      (id, owner_id, project_id, code_hash, created_at, expires_at, credential_ttl_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.owner_id, row.project_id, row.code_hash, row.created_at, row.expires_at, credentialTtl);
    return { code, invitation: invitationMetadata(row) };
  }
  /** A successful transaction consumes the invitation. Lost responses require a new invitation, never replay. */
  redeemInvitation(code: string, machineId: string): { token: string; identity: WorkerIdentity; credential: CredentialMetadata } {
    const validCode = secret(code, 'ymi_'); if (!validCode) fail();
    id(machineId);
    return tx(this.db, () => {
      const now = timestamp(this.now());
      const row = this.db.prepare('SELECT * FROM fleet_invitations WHERE code_hash = ?').get(hash(validCode)) as unknown as InvitationRow | undefined;
      if (!row || !equal(row.code_hash, hash(validCode)) || row.owner_id !== this.ownerId || row.revoked_at !== null ||
          row.redeemed_at !== null || !Number.isSafeInteger(row.expires_at) || row.expires_at <= now ||
          row.created_at > now || !this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(row.project_id)) fail();
      const changed = this.db.prepare('UPDATE fleet_invitations SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
        .run(now, row.id, now);
      if (Number(changed.changes) !== 1) fail();
      const token = `ymw_${randomBytes(32).toString('base64url')}`;
      const credential: CredentialRow = { id: `worker-${randomUUID()}`, owner_id: row.owner_id, project_id: row.project_id,
        machine_id: machineId, token_hash: hash(token), created_at: now,
        expires_at: timestamp(now + integer(row.credential_ttl_ms, 1000, 365 * DAY)), revoked_at: null };
      this.db.prepare(`INSERT INTO fleet_credentials (id, owner_id, project_id, machine_id, token_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(credential.id, credential.owner_id, credential.project_id, machineId, credential.token_hash, now, credential.expires_at);
      return { token, identity: identity(credential), credential: metadata(credential) };
    });
  }
  authenticate(token: string): WorkerIdentity | null {
    const validToken = secret(token, 'ymw_'); if (!validToken) return null;
    const row = this.db.prepare('SELECT * FROM fleet_credentials WHERE token_hash = ?').get(hash(validToken)) as unknown as CredentialRow | undefined;
    const now = timestamp(this.now());
    if (!row || !equal(row.token_hash, hash(validToken)) || row.owner_id !== this.ownerId || !liveCredential(this.db, row, now)) return null;
    return identity(row);
  }
  revokeCredential(actor: OwnerIdentity, credentialId: string): boolean {
    this.owner(actor); id(credentialId);
    return Number(this.db.prepare('UPDATE fleet_credentials SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL')
      .run(timestamp(this.now()), credentialId, this.ownerId).changes) === 1;
  }
  revokeInvitation(actor: OwnerIdentity, invitationId: string): boolean {
    this.owner(actor); id(invitationId);
    return Number(this.db.prepare('UPDATE fleet_invitations SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL')
      .run(timestamp(this.now()), invitationId, this.ownerId).changes) === 1;
  }
  listCredentials(actor: OwnerIdentity, limit = 100): CredentialMetadata[] {
    this.owner(actor); integer(limit, 1, 500);
    return (this.db.prepare('SELECT * FROM fleet_credentials WHERE owner_id = ? ORDER BY created_at DESC, id LIMIT ?')
      .all(this.ownerId, limit) as unknown as CredentialRow[]).map(metadata);
  }
  listInvitations(actor: OwnerIdentity, limit = 100): InvitationMetadata[] {
    this.owner(actor); integer(limit, 1, 500);
    return (this.db.prepare('SELECT * FROM fleet_invitations WHERE owner_id = ? ORDER BY created_at DESC, id LIMIT ?')
      .all(this.ownerId, limit) as unknown as InvitationRow[]).map(invitationMetadata);
  }
}

function liveCredential(db: Db, row: CredentialRow, now: number): boolean {
  return row.revoked_at === null && Number.isSafeInteger(row.created_at) && row.created_at <= now &&
    Number.isSafeInteger(row.expires_at) && row.expires_at > now &&
    !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(row.project_id);
}
/** Recheck durable revocation on every call, even when the principal was authenticated earlier. */
function principal(coord: Coordinator, who: WorkerIdentity): void {
  if (!who || who.kind !== 'worker') fail();
  id(who.credentialId); id(who.ownerId); id(who.projectId); id(who.machineId); integer(who.expiresAt);
  const row = coord.db.prepare('SELECT * FROM fleet_credentials WHERE id = ?').get(who.credentialId) as unknown as CredentialRow | undefined;
  if (!row || !liveCredential(coord.db, row, Date.now()) || !equal(row.owner_id, who.ownerId) || row.project_id !== who.projectId ||
      row.machine_id !== who.machineId || row.expires_at !== who.expiresAt) fail();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  return value as Record<string, unknown>;
}
/** Bound work before the API schema parses it; HTTP integration must also cap request bytes. */
function bounded(value: unknown, depth = 0, budget = { nodes: 0, chars: 0 }): void {
  if (++budget.nodes > 10_000 || depth > 12) fail();
  if (typeof value === 'string') { budget.chars += value.length; if (value.length > 100_000 || budget.chars > 512_000) fail(); }
  else if (Array.isArray(value)) { if (value.length > 2000) fail(); for (const v of value) bounded(v, depth + 1, budget); }
  else if (value !== null && typeof value === 'object') {
    const obj = record(value); const keys = Object.keys(obj); if (keys.length > 2000) fail();
    for (const key of keys) { bounded(key, depth + 1, budget); bounded(obj[key], depth + 1, budget); }
  } else if (value !== null && !['boolean', 'number', 'undefined'].includes(typeof value)) fail();
  else if (typeof value === 'number' && !Number.isFinite(value)) fail();
}
function project(who: WorkerIdentity, value: unknown): void { if (id(value) !== who.projectId) fail(); }
function task(coord: Coordinator, who: WorkerIdentity, value: unknown): Task {
  const t = coord.getTask(id(value)); if (!t || t.project_id !== who.projectId) fail(); return t;
}
/** Existing owner APIs permit cross-project dependencies; expanded reads must not reveal their titles/data. */
function expandedTask(coord: Coordinator, who: WorkerIdentity, value: unknown): Task {
  const t = task(coord, who, value);
  const linked = [...coord.depsOf(t.id), ...coord.dependentsOf(t.id)];
  if (t.wait_for) linked.push(task(coord, who, t.wait_for));
  if (t.race_group) linked.push(...coord.raceMembers(t.race_group));
  for (const linkedTask of linked) {
    if (linkedTask.project_id !== who.projectId) fail();
    if (linkedTask.race_group && coord.raceMembers(linkedTask.race_group).some(member => member.project_id !== who.projectId)) fail();
  }
  return t;
}
function owner(who: WorkerIdentity, value: unknown, statuses = WORKER_ACTIVE_STATUSES): ClaimOwner & { generation: number } {
  const o = record(value); const generation = integer(o.generation);
  if (o.assignee !== `machine:${who.machineId}`) fail();
  // The method policy, shared with dispatch, determines the fence.
  if (o.statuses !== undefined && (!Array.isArray(o.statuses) || !o.statuses.length ||
      o.statuses.some(s => !statuses.includes(s as Task['status'])))) fail();
  return { generation, assignee: o.assignee, statuses };
}
function currentTask(coord: Coordinator, who: WorkerIdentity, value: unknown, claim: unknown, statuses = WORKER_ACTIVE_STATUSES): Task {
  const t = task(coord, who, value); const o = owner(who, claim, statuses);
  if (t.machine_id !== who.machineId) fail();
  coord.assertTaskOwner(t.id, o); return t;
}
function ownRun(coord: Coordinator, who: WorkerIdentity, runId: unknown, claim: unknown, taskId?: unknown, historical = false, statuses = WORKER_ACTIVE_STATUSES): Run {
  const r = coord.getRun(id(runId)); const o = owner(who, claim, statuses);
  if (!r || r.machine_id !== who.machineId || r.generation !== o.generation || (taskId !== undefined && r.task_id !== taskId)) fail();
  task(coord, who, r.task_id);
  if (!historical) currentTask(coord, who, r.task_id, claim, statuses);
  return r;
}
const TASK_PATCH = new Set(['status', 'attempts', 'tier', 'branch', 'worktree', 'base_sha', 'head_sha', 'lease_until',
  'not_before', 'wait_for', 'pending_rebase', 'summary', 'last_error', 'retry_note', 'error_fp', 'same_error_count',
  'conflict_rounds', 'attention', 'started_at', 'finished_at', 'ready_at', 'review_rounds', 'agent_session', 'session_agent',
  'session_cost', 'session_at', 'session_fingerprint', 'assignee', 'machine_id']);
const RUN_PATCH = new Set(['pid', 'proc_started', 'status', 'stop_reason', 'exit_code', 'cost_usd', 'tokens_in', 'tokens_out',
  'cost_estimated', 'last_activity', 'touched', 'ended_at', 'lessons', 'verdict', 'phases', 'resumed', 'phase', 'effort', 'effort_source', 'launch_fingerprint', 'verdict_sha']);

/** Assert before dispatch; return value intentionally contains no replacement params or secret.
 * Deny by default. Existing API validation and transactional generation fences remain mandatory at mutation time.
 * Do not await between this check and synchronous dispatch. Recheck bundle guards after awaited transfer/import.
 */
export function authorizeWorkerRpc(coord: Coordinator, who: WorkerIdentity, method: string, params: unknown): void {
  principal(coord, who); bounded(params);
  const p = record(params);
  switch (method) {
    case 'task.list': case 'events.since': case 'lesson.list': case 'lock.check':
      project(who, p.projectId);
      if (p.taskId !== undefined && p.taskId !== null) task(coord, who, p.taskId);
      return;
    case 'task.peek':
      task(coord, who, p.id); return;
    case 'task.get': case 'task.context':
      expandedTask(coord, who, p.id); return;
    case 'task.wait':
      if (!Array.isArray(p.ids) || !p.ids.length || p.ids.length > 50) fail();
      for (const value of p.ids) expandedTask(coord, who, value);
      return;
    case 'worker.claim': {
      if (p.machineId !== who.machineId) fail();
      const repos = record(p.repos);
      if (Object.keys(repos).length !== 1 || typeof repos[who.projectId] !== 'string') fail();
      return;
    }
    case 'machine.heartbeat': {
      if (p.id !== who.machineId) fail();
      const info = record(p.info);
      const repos = record(info.repos);
      if (Object.keys(repos).some(key => key !== who.projectId) || info.is_hub || info.isHub) fail();
      if (!Array.isArray(p.running) || p.running.length > 50) fail();
      for (const raw of p.running) {
        const r = record(raw); const o = { generation: r.generation, assignee: `machine:${who.machineId}` };
        // Stale claims must not prevent this machine's other leases from renewing.
        // Dispatch renews each generation independently and returns per-entry controls.
        task(coord, who, r.taskId); owner(who, o);
        if (r.runId !== undefined && r.runId !== null) ownRun(coord, who, r.runId, o, r.taskId, true);
      }
      return;
    }
    case 'task.update': {
      currentTask(coord, who, p.id, p.owner); const patch = record(p.patch);
      if (Object.keys(patch).some(key => !TASK_PATCH.has(key))) fail();
      if ('assignee' in patch && patch.assignee !== null && patch.assignee !== `machine:${who.machineId}`) fail();
      if ('machine_id' in patch && patch.machine_id !== null && patch.machine_id !== who.machineId) fail();
      if ('wait_for' in patch && patch.wait_for !== null) task(coord, who, patch.wait_for);
      // Acceptance/landing belongs to the hub, never to a worker reporting completion.
      if ('status' in patch && !['queued', 'running', 'verifying', 'ready', 'needs_human', 'failed'].includes(String(patch.status))) fail();
      return;
    }
    case 'run.start':
      if (p.machineId !== who.machineId) fail();
      currentTask(coord, who, p.taskId, p.owner); return;
    case 'run.update':
      ownRun(coord, who, p.runId, p.owner, undefined, false, WORKER_FINALIZE_STATUSES);
      if (Object.keys(record(p.patch)).some(key => !RUN_PATCH.has(key))) fail();
      return;
    case 'run.log':
      ownRun(coord, who, p.runId, p.owner, undefined, false, WORKER_FINALIZE_STATUSES); return;
    case 'task.usage':
      currentTask(coord, who, p.id, p.owner); ownRun(coord, who, p.runId, p.owner, p.id); return;
    case 'task.touched': case 'lesson.outcome':
      currentTask(coord, who, p.taskId, p.owner); ownRun(coord, who, p.runId, p.owner, p.taskId); return;
    case 'task.event':
      project(who, p.projectId); currentTask(coord, who, p.taskId, p.owner, WORKER_FINALIZE_STATUSES); return;
    case 'run.exit':
      if (p.reaped !== true) fail();
      ownRun(coord, who, p.runId, p.owner, p.taskId, true); return;
    case 'run.usage':
      // Reserved for an optional ledger endpoint. Dispatch still rejects it unless installed.
      // Historical accounting grants no right to update/log/renew an old claim or its lifecycle.
      ownRun(coord, who, p.runId, p.owner, p.taskId, true); return;
    default: fail();
  }
}

export function authorizeWorkerBaseBundle(coord: Coordinator, who: WorkerIdentity, projectId: string): void {
  principal(coord, who); project(who, projectId);
}
export function authorizeWorkerUpload(coord: Coordinator, who: WorkerIdentity, input: {
  taskId: string; machineId: string; generation: number; head: string; branch: string;
}): void {
  principal(coord, who); bounded(input);
  if (input.machineId !== who.machineId) fail();
  task(coord, who, input.taskId); integer(input.generation);
  coord.assertBundleOwner(input.taskId, who.machineId, input.generation, input.head, input.branch);
}
