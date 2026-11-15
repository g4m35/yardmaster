import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { yardHome } from './paths.ts';

export interface ServiceContext { sha?: string | null; projectId?: string; taskId?: string; runId?: string }

/** Write before dispatch and replace atomically after completion. Request inputs/options/env are not added to metadata. */
export function serviceReceipt(requestId: string, metadata: Record<string, unknown>) {
  const directory = join(yardHome(), 'service-runs', requestId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'result.json');
  const write = (value: Record<string, unknown>) => {
    const temp = join(directory, 'result.tmp');
    const fd = openSync(temp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, file);
  };
  const startedAt = new Date().toISOString();
  let processIdentity: { pid: number; startedAt: number | null } | undefined;
  write({ ...metadata, requestId, startedAt, state: 'running' });
  return { directory, file,
    spawned: (process: { pid: number; startedAt: number | null }) => { processIdentity = process; write({ ...metadata, requestId, startedAt, state: 'running', process: processIdentity }); },
    finish: (result: Record<string, unknown>) => write({ ...metadata, requestId, startedAt, process: processIdentity,
    completedAt: new Date().toISOString(), state: 'completed', ...result }) };
}
