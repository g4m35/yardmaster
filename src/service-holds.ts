import type { Db } from './db.ts';
import { tx } from './transaction.ts';

export interface ServiceIntent { requestId: string; capability: string; provider: string; receiptPath: string }
export interface ServiceHold extends ServiceIntent {
  scope: string; projectId: string; taskIds: string[]; machineId?: string; runId?: string;
  startedAt: number; state: 'pending' | 'unknown';
}
const prefix = 'service-hold:';
export function serviceHold(db: Db, scope: string): ServiceHold | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(prefix + scope) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as ServiceHold : null;
}
export function serviceHolds(db: Db): ServiceHold[] {
  return (db.prepare("SELECT value FROM meta WHERE key GLOB 'service-hold:*'").all() as { value: string }[]).map(row => JSON.parse(row.value) as ServiceHold);
}
export function beginService(db: Db, scope: string, intent: ServiceIntent, identity: Omit<ServiceHold, keyof ServiceIntent | 'scope' | 'startedAt' | 'state'>): void {
  tx(db, () => {
    const held = serviceHold(db, scope);
    if (held) throw new Error(`Provider request ${held.requestId} needs inspection. Use ym providers pending, then resolve it with an inspection note.`);
    const hold: ServiceHold = { ...intent, ...identity, scope, startedAt: Date.now(), state: 'pending' };
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(prefix + scope, JSON.stringify(hold));
  });
}
export function finishService(db: Db, scope: string, requestId: string, status: 'passed' | 'failed' | 'unknown', reaped: boolean): void {
  tx(db, () => {
    const hold = serviceHold(db, scope);
    if (!hold || hold.requestId !== requestId) throw new Error('Service completion does not match the durable dispatch intent');
    if (status === 'unknown' || !reaped) db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify({ ...hold, state: 'unknown' }), prefix + scope);
    else db.prepare('DELETE FROM meta WHERE key = ?').run(prefix + scope);
  });
}
/** Owner inspection only. Retain the attestation separately; never redispatch here. */
export function resolveService(db: Db, requestId: string, note: string): ServiceHold {
  if (note.trim().length < 12) throw new Error('Describe the inspected remote state (at least 12 characters)');
  return tx(db, () => {
    const hold = serviceHolds(db).find(item => item.requestId === requestId);
    if (!hold) throw new Error('No unresolved service request with that ID');
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`service-resolution:${requestId}`, JSON.stringify({ ...hold, resolvedAt: Date.now(), note }));
    db.prepare('DELETE FROM meta WHERE key = ?').run(prefix + hold.scope);
    return hold;
  });
}
