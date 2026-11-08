import type { Db } from './db.ts';
import { tx } from './transaction.ts';

export const controllerActivityKey = (taskId: string) => `http_activity:${taskId}`;

/** Only HTTP entry points call this after authorization; a machine heartbeat alone is not claim activity. */
export function noteControllerActivity(db: Db, taskId: string, machineId: string, generation: number | undefined): void {
  if (!Number.isSafeInteger(generation) || (generation ?? 0) < 1) return;
  tx(db, () => {
    const current = db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND machine_id = ? AND assignee = ? AND generation = ?
      AND status IN ('running','verifying','ready')`).get(taskId, machineId, `machine:${machineId}`, generation!);
    if (!current) return;
    db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(controllerActivityKey(taskId), JSON.stringify({ machineId, generation, seenAt: Date.now() }));
  });
}

/** Only absent records use legacy policy. Invalid or foreign records never borrow a machine heartbeat. */
export function controllerLastSeen(db: Db, taskId: string, machineId: string, generation: number): number | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(controllerActivityKey(taskId)) as { value: string } | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.value);
    return value?.machineId === machineId && value.generation === generation && Number.isSafeInteger(value.seenAt) &&
      value.seenAt >= 0 && value.seenAt <= Date.now() ? value.seenAt : 0;
  } catch { return 0; }
}
