import type { Db } from './db.ts';
import { tx } from './transaction.ts';
import { terminateRecordedProcess, type ProcessScopeOptions } from './proc.ts';
import { basename } from 'node:path';

export interface UtilityRecord {
  token: string; command: string; state: 'spawning' | 'live' | 'held' | 'exited';
  pid: number | null; startedAt: number | null;
  preservationId?: string;
}
export type UtilityOperation =
  | { action: 'intent'; token: string; command: string; preserving?: boolean; preservationId?: string }
  | { action: 'spawn'; token: string; pid: number; startedAt: number | null }
  | { action: 'exit'; token: string; pid: number | null; startedAt: number | null; reaped: boolean };
export const runUtilityKey = (runId: string) => `utility:run:${runId}`;
export const integrationUtilityKey = (projectId: string) => `utility:integration:${projectId}`;
/** Shared fail-closed predicate for a utility scope stored in meta under alias m. */
export const PENDING_UTILITY_SQL = `(NOT json_valid(m.value) OR EXISTS (
  SELECT 1 FROM json_each(CASE WHEN json_valid(m.value) THEN m.value ELSE '[]' END) child
  WHERE COALESCE(json_extract(child.value, '$.state'), 'unknown') <> 'exited'))`;

export function utilities(db: Db, key: string): UtilityRecord[] {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as UtilityRecord[] : [];
}
export function utilitiesStopped(db: Db, key: string): boolean {
  return utilities(db, key).every(child => child.state === 'exited');
}
export function taskHasPendingUtilities(db: Db, taskId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM runs r JOIN meta m ON m.key = 'utility:run:' || r.id
    WHERE r.task_id = ? AND ${PENDING_UTILITY_SQL} LIMIT 1`).get(taskId);
}
/** Exited tokens remain tombstones until the scope closes, so late PID registration cannot resurrect one. */
export function applyUtilityOperation(previous: UtilityRecord[], op: UtilityOperation): UtilityRecord[] {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(op.token)) throw new Error('Invalid utility token.');
  const records = previous.map(record => ({ ...record }));
    let child = records.find(record => record.token === op.token);
    if (op.action === 'intent') {
      if (child?.state === 'exited') throw new Error('Utility already exited; late spawn intent refused.');
      if (!child) {
        child = { token: op.token, command: basename(op.command).slice(0, 200), state: 'spawning', pid: null, startedAt: null,
          ...(op.preserving && op.preservationId ? { preservationId: op.preservationId } : {}) };
        records.push(child);
      }
    } else if (op.action === 'spawn') {
      if (!child || child.state === 'exited') throw new Error('Utility has no live spawn intent.');
      if (child.pid !== null && (child.pid !== op.pid || child.startedAt !== op.startedAt)) throw new Error('Utility process identity changed.');
      Object.assign(child, { pid: op.pid, startedAt: op.startedAt, state: 'live' });
    } else {
      if (!child) {
        if (!op.reaped || op.pid !== null) throw new Error('Unknown utility exit.');
        // A pre-spawn hook may time out before the intent reaches this server.
        child = { token: op.token, command: 'unlaunched', state: 'exited', pid: null, startedAt: null };
        records.push(child);
      }
      if (child.pid !== null && (child.pid !== op.pid || child.startedAt !== op.startedAt)) throw new Error('Utility exit identity changed.');
      if (child.state !== 'exited') Object.assign(child, { pid: op.pid, startedAt: op.startedAt, state: op.reaped ? 'exited' : 'held' });
    }
  return records;
}
export function recordUtility(db: Db, key: string, op: UtilityOperation): void {
  tx(db, () => {
    const records = applyUtilityOperation(utilities(db, key), op);
    db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(records));
  });
}
export function forgetStoppedUtilities(db: Db, key: string): void {
  if (!utilitiesStopped(db, key)) throw new Error('Utility processes are still held.');
  db.prepare('DELETE FROM meta WHERE key = ?').run(key);
}
export async function recoverUtilities(db: Db, key: string): Promise<boolean> {
  let confirmed = true;
  for (const child of utilities(db, key).filter(child => child.state !== 'exited')) {
    if (child.pid === null) { confirmed = false; continue; }
    const proof = await terminateRecordedProcess({ pid: child.pid, startedAt: child.startedAt });
    if (!['exited', 'terminated'].includes(proof.status)) { confirmed = false; continue; }
    recordUtility(db, key, { action: 'exit', token: child.token, pid: child.pid, startedAt: child.startedAt, reaped: true });
  }
  return confirmed;
}
export function utilityHooks(db: Db, key: string): ProcessScopeOptions {
  return {
    beforeSpawn: child => recordUtility(db, key, { action: 'intent', token: child.token, command: child.command }),
    onSpawn: (token, child) => recordUtility(db, key, { action: 'spawn', token, pid: child.pid, startedAt: child.startedAt }),
    onExit: (token, result) => recordUtility(db, key, { action: 'exit', token, pid: result.pid, startedAt: result.startedAt, reaped: result.reaped }),
  };
}
