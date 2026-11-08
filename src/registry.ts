import type { Db } from './db.ts';
import { utilities, runUtilityKey, type UtilityRecord } from './utility-records.ts';

/** Append alongside pairing.migrationDDL in the versioned migration list, never on a registry read. */
export const registryMigrationDDL = `
CREATE INDEX runs_registry_live ON runs(status, started_at DESC);
CREATE INDEX runs_registry_history ON runs(task_id, started_at DESC);
CREATE INDEX sessions_registry_project ON sessions(project_id, last_seen DESC);
CREATE INDEX sessions_registry_seen ON sessions(last_seen DESC);
CREATE INDEX machines_registry_seen ON machines(last_seen DESC);
`;

export type RegistryState = 'managed' | 'observed' | 'stale' | 'unconnected';
export interface RegistryEntry {
  id: string;
  source: 'run' | 'session' | 'machine-advertisement';
  state: RegistryState;
  agent: string | null;
  model: string | null;
  role: string | null;
  phase: string | null;
  effort: string | null;
  effortSource?: string | null;
  launchFingerprint?: string | null;
  usage?: { costUsd: number; tokensIn: number; tokensOut: number; provenance: string };
  /** Persisted ownership records, not a claim of current OS liveness. */
  utilityChildren?: UtilityRecord[];
  utilityChildrenTruncated?: boolean;
  cache: { readTokens: number | null; writeTokens: number | null };
  machineId: string | null;
  machineName: string | null;
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
  sessionId: string | null;
  generation: number | null;
  pid: number | null;
  processStartedAt: number | null;
  status: string;
  startedAt: number | null;
  endedAt: number | null;
  /** A persisted text signal, never a parsed native transcript or synthetic completion percentage. */
  lastActivity: string | null;
  lastSeenAt: number | null;
  ageMs: number | null;
  freshness: 'fresh' | 'stale' | 'unknown';
  online: boolean | null;
  capabilities: { inspect: boolean; requestStop: boolean; nativeStop: false };
}
export interface RegistrySnapshot {
  generatedAt: number;
  projectId: string | null;
  entries: RegistryEntry[];
  coverage: {
    liveRuns: number;
    recentRuns: number;
    sessionsTruncated: boolean;
    machinesTruncated: boolean;
    historyLimit: number;
    /** These are unavailable unless a future bridge persists attested fields. */
    unknownSignals: readonly string[];
  };
}
interface MachineRow { id: string; name: string; info: string; last_seen: number }
interface SessionRow { id: string; agent: string | null; project_id: string | null; machine_id: string | null; last_seen: number }
interface SessionClaim { id: string; generation: number; machine_id: string | null; status: string; project_id: string }
interface RunRow {
  id: string; task_id: string; generation: number; machine_id: string; agent: string; model: string | null;
  role: string; pid: number | null; proc_started: number | null; status: string; last_activity: string | null;
  started_at: number; ended_at: number | null; project_id: string; task_generation: number;
  task_assignee: string | null; task_machine: string | null; task_status: string; task_lease: number | null;
  phase: string | null; effort: string | null; cache_read_tokens: number | null; cache_write_tokens: number | null;
  effort_source: string | null; launch_fingerprint: string | null; cost_usd: number; tokens_in: number; tokens_out: number; usage_provenance: string;
}
function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function text(value: unknown): string | null { return typeof value === 'string' ? value.slice(0, 2000) : null; }
function json(value: string): Record<string, unknown> {
  // Heartbeat metadata should be small. Corrupt or huge stored records are not discovery evidence.
  if (value.length > 100_000) return {};
  try { const x: unknown = JSON.parse(value); return x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {}; }
  catch { return {}; }
}
function freshness(at: number | null, now: number, threshold: number): Pick<RegistryEntry, 'ageMs' | 'freshness'> {
  if (at === null || at > now) return { ageMs: null, freshness: 'unknown' };
  return { ageMs: now - at, freshness: now - at < threshold ? 'fresh' : 'stale' };
}
function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid registry bounds');
  return value;
}
const RUN_COLUMNS = `SELECT r.id, r.task_id, r.generation, r.machine_id, r.agent, r.model, r.role,
  r.pid, r.proc_started, r.status, r.last_activity, r.started_at, r.ended_at, r.phase, r.effort, r.effort_source, r.launch_fingerprint,
  r.cost_usd, r.tokens_in, r.tokens_out, r.usage_provenance, r.cache_read_tokens, r.cache_write_tokens, COALESCE(t.project_id, p.id) AS project_id,
  t.generation AS task_generation, t.assignee AS task_assignee, t.machine_id AS task_machine,
  t.status AS task_status, t.lease_until AS task_lease FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
  LEFT JOIN projects p ON r.role = 'plan' AND r.task_id = 'plan:' || p.id`;

/** Database-only projection for one personal hub. No process scans, native polling, file reads or host discovery.
 * Live runs are deliberately uncapped so concurrent review rows cannot disappear behind a history limit.
 * History and passive inventory are capped; coverage explicitly reports truncated passive inventory.
 * Scope this server-side using the authenticated project, never a worker-supplied dashboard filter.
 */
export function buildRegistry(db: Db, options: {
  projectId?: string; now?: number; staleAfterMs?: number; historyLimit?: number; inventoryLimit?: number;
} = {}): RegistrySnapshot {
  const now = bounded(options.now ?? Date.now(), 0, Number.MAX_SAFE_INTEGER);
  const staleAfter = bounded(options.staleAfterMs ?? 120_000, 1000, 86_400_000);
  const historyLimit = bounded(options.historyLimit ?? 100, 0, 500);
  const inventoryLimit = bounded(options.inventoryLimit ?? 500, 1, 2000);
  const projectId = options.projectId ?? null;
  if (projectId !== null && !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}$/.test(projectId)) throw new Error('Invalid registry project');
  const filter = projectId === null ? '' : ' AND COALESCE(t.project_id, p.id) = ?';
  const args = projectId === null ? [] : [projectId];
  const live = db.prepare(`${RUN_COLUMNS} WHERE r.status = 'running'${filter} ORDER BY r.started_at DESC, r.id`)
    .all(...args) as unknown as RunRow[];
  const recent = historyLimit ? db.prepare(`${RUN_COLUMNS} WHERE r.status <> 'running'${filter}
    ORDER BY r.started_at DESC, r.id LIMIT ?`).all(...args, historyLimit) as unknown as RunRow[] : [];
  const sessions = db.prepare(`SELECT id, agent, project_id, machine_id, last_seen FROM sessions
    ${projectId === null ? '' : 'WHERE project_id = ?'} ORDER BY last_seen DESC, id LIMIT ?`)
    .all(...args, inventoryLimit + 1) as unknown as SessionRow[];
  // Load only associated machines for a project, and never emit a machine's repos or other project names.
  const machines = db.prepare(`SELECT id, name, info, last_seen FROM machines
    ${projectId === null ? '' : `WHERE id IN (SELECT machine_id FROM sessions WHERE project_id = ?
      UNION SELECT r.machine_id FROM runs r WHERE r.task_id IN (SELECT id FROM tasks WHERE project_id = ?) OR r.task_id = 'plan:' || ?)
      OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(info) THEN info ELSE '{}' END, '$.repos') WHERE key = ?)`}
    ORDER BY last_seen DESC, id LIMIT ?`).all(...(projectId === null ? [] : [projectId, projectId, projectId, projectId]), inventoryLimit + 1) as unknown as MachineRow[];
  const machineMap = new Map(machines.slice(0, inventoryLimit).map(m => [m.id, m]));
  // A live run's machine stays observable even when passive inventory exceeds its cap.
  const machineById = (machineId: string | null): MachineRow | null => {
    if (machineId === null) return null;
    if (machineMap.has(machineId)) return machineMap.get(machineId)!;
    const m = db.prepare('SELECT id, name, info, last_seen FROM machines WHERE id = ?').get(machineId) as unknown as MachineRow | undefined;
    if (m) machineMap.set(m.id, m);
    return m ?? null;
  };
  function base(machineId: string | null): Pick<RegistryEntry, 'machineId' | 'machineName' | 'online'> {
    const machine = machineById(machineId);
    const f = freshness(machine ? number(machine.last_seen) : null, now, staleAfter);
    return { machineId, machineName: machine ? text(machine.name) : null,
      online: f.freshness === 'unknown' ? null : f.freshness === 'fresh' };
  }
  const entries: RegistryEntry[] = [];
  for (const r of [...live, ...recent]) {
    const machine = machineById(r.machine_id);
    // The schema has no run activity timestamp. Machine heartbeat proves connection, not process activity.
    const lastSeenAt = machine ? number(machine.last_seen) : null;
    const f = freshness(lastSeenAt, now, staleAfter);
    const active = r.status === 'running';
    const planning = r.role === 'plan' && !!r.project_id;
    const current = planning || (r.generation > 0 && r.generation === r.task_generation && r.task_machine === r.machine_id &&
      r.task_assignee === `machine:${r.machine_id}` && ['running', 'verifying', 'ready'].includes(r.task_status) &&
      (r.task_status === 'ready' || (r.task_lease !== null && r.task_lease > now)));
    const pid = number(r.pid);
    const processStartedAt = number(r.proc_started);
    const children = utilities(db, runUtilityKey(r.id)).filter(child => child.state !== 'exited');
    entries.push({ id: `run:${r.id}`, source: 'run', state: active && (!current || f.freshness !== 'fresh') ? 'stale' : 'managed',
      agent: text(r.agent), model: text(r.model), role: text(r.role), phase: text(r.phase), effort: text(r.effort),
      effortSource: text(r.effort_source), launchFingerprint: text(r.launch_fingerprint),
      utilityChildren: children.slice(0, 50), utilityChildrenTruncated: children.length > 50,
      usage: { costUsd: r.cost_usd, tokensIn: r.tokens_in, tokensOut: r.tokens_out, provenance: r.usage_provenance },
      cache: { readTokens: number(r.cache_read_tokens), writeTokens: number(r.cache_write_tokens) }, ...base(r.machine_id), projectId: r.project_id,
      taskId: planning ? null : r.task_id, runId: r.id, sessionId: null, generation: number(r.generation),
      pid: pid !== null && pid > 0 ? pid : null, processStartedAt,
      status: r.status, startedAt: number(r.started_at), endedAt: number(r.ended_at),
      lastActivity: text(r.last_activity), lastSeenAt, ...f,
      capabilities: { inspect: true, requestStop: !planning && active && current && f.freshness === 'fresh' && pid !== null && pid > 0 && processStartedAt !== null,
        nativeStop: false } });
  }
  for (const s of sessions.slice(0, inventoryLimit)) {
    const lastSeenAt = number(s.last_seen); const f = freshness(lastSeenAt, now, staleAfter);
    const machine = base(s.machine_id);
    // A hooked session can hold several tasks. Show each existing claim without granting native stop.
    const claims = db.prepare(`SELECT id, generation, machine_id, status, project_id FROM tasks
      WHERE project_id = ? AND assignee = ? AND status IN ('running', 'verifying', 'ready') ORDER BY id`)
      .all(s.project_id, s.id) as unknown as SessionClaim[];
    for (const claim of claims.length ? claims : [null]) entries.push({ id: `session:${s.id}${claim ? `:task:${claim.id}` : ''}`,
      source: 'session', state: f.freshness === 'fresh' && machine.online !== false ? 'observed' : 'stale',
      agent: text(s.agent), model: null, role: null, phase: null, effort: null, cache: { readTokens: null, writeTokens: null },
      ...machine, projectId: s.project_id, taskId: claim?.id ?? null, runId: null, sessionId: s.id, generation: claim ? number(claim.generation) : null,
      pid: null, processStartedAt: null, status: claim?.status ?? 'observed', startedAt: null, endedAt: null, lastActivity: null,
      lastSeenAt, ...f, capabilities: { inspect: true, requestStop: false, nativeStop: false } });
  }
  const connected = new Set(entries.filter(e => e.agent !== null && (e.source === 'session' || (e.source === 'run' && e.status === 'running')))
    .map(e => JSON.stringify([e.machineId, e.agent])));
  for (const m of machines.slice(0, inventoryLimit)) {
    const info = json(m.info);
    const agents = Array.isArray(info.agents) ? info.agents.slice(0, 100) : [];
    for (const agent of new Set(agents.filter((a): a is string => typeof a === 'string' && a.length > 0 && a.length <= 200))) {
      if (connected.has(JSON.stringify([m.id, agent]))) continue;
      const lastSeenAt = number(m.last_seen); const f = freshness(lastSeenAt, now, staleAfter);
      entries.push({ id: `installed:${m.id}:${agent}`, source: 'machine-advertisement', state: 'unconnected', agent,
        model: null, role: null, phase: null, effort: null, cache: { readTokens: null, writeTokens: null },
        ...base(m.id), projectId, taskId: null, runId: null, sessionId: null, generation: null, pid: null, processStartedAt: null,
        status: 'unconnected', startedAt: null, endedAt: null, lastActivity: null, lastSeenAt, ...f,
        capabilities: { inspect: false, requestStop: false, nativeStop: false } });
    }
  }
  return { generatedAt: now, projectId, entries,
    coverage: { liveRuns: live.length, recentRuns: recent.length, historyLimit,
      sessionsTruncated: sessions.length > inventoryLimit, machinesTruncated: machines.length > inventoryLimit,
      unknownSignals: ['native process liveness', 'native session model and effort', 'unreported provider cache counters and cache residency',
        'per-run last activity timestamp', 'unbridged native hosts', 'native stop capability'] } };
}
