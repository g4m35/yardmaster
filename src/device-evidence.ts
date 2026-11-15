import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod/v4';
import type { Db } from './db.ts';

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Text = (max: number) => z.string().max(max);
export const CHECK_STATUSES = ['passed', 'failed', 'unknown', 'unavailable', 'skipped'] as const;

/**
 * One portable record per device verification. A simulator pass is never a physical-device pass: the two are
 * separate fields, and `overall` only passes when the stated requirement was met on that class of device.
 */
export const DeviceEvidenceSchema = z.object({
  kind: z.literal('yardmaster.device-evidence'),
  version: z.literal(1),
  requestId: z.string().max(100).nullable(),
  projectId: z.string().max(200).nullable(),
  taskId: z.string().max(100).nullable(),
  /** The committed artifact source these checks are bound to. */
  commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  requirement: z.enum(['simulator', 'physical']),
  status: z.object({
    /** Configured shell checks ran and passed before this device run (acceptance runs them first). */
    code: z.enum(['passed', 'not-run']),
    simulator: z.enum(['passed', 'failed', 'unknown', 'not-run']),
    physical: z.enum(['untested', 'passed', 'failed', 'unknown']),
    overall: z.enum(['passed', 'failed', 'unknown']),
  }),
  artifact: z.object({
    path: Text(4096), sha256: Sha256, bundleId: Text(300),
    source: z.enum(['built', 'reused', 'existing']),
    /** Compatibility key reported by the project's own tool; reuse happens only on an exact match. */
    fingerprint: Text(300).nullable(),
    builtFromCommit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  }).nullable(),
  environment: z.object({ machineId: Text(200), os: Text(200), arch: Text(40), xcode: Text(200).nullable() }),
  device: z.object({
    kind: z.enum(['simulator', 'physical']), name: Text(200), model: Text(200), modelIdentifier: Text(200).nullable(),
    runtime: Text(200), runtimeIdentifier: Text(300), udid: Text(100), createdByYardmaster: z.boolean(),
  }).nullable(),
  checks: z.array(z.object({
    name: Text(80), runner: Text(40), status: z.enum(CHECK_STATUSES),
    durationMs: z.number().int().nonnegative().nullable(), detail: Text(2000), log: Text(4096).nullable(),
  })).max(40),
  files: z.array(z.object({ path: Text(4096), sha256: Sha256, kind: z.enum(['screenshot', 'log', 'report']) })).max(100),
  lease: z.object({
    id: Text(100), pool: Text(40), queuedAt: z.number(), acquiredAt: z.number().nullable(), releasedAt: z.number().nullable(),
    waitedMs: z.number().nonnegative(), cleanup: z.enum(['released', 'cleanup_failed', 'not-acquired']),
  }).nullable(),
  startedAt: Text(40),
  completedAt: Text(40),
  summary: Text(2000),
});
export type DeviceEvidence = z.infer<typeof DeviceEvidenceSchema>;

export function fileSha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Content identity for an app bundle directory (or a single file): sorted relative paths with each file's hash,
 * symlink targets included. Timestamps and ownership are not part of the identity.
 */
export function artifactSha256(path: string): string {
  const top = lstatSync(path);
  if (top.isFile()) return fileSha256(path);
  if (!top.isDirectory()) throw new Error(`Artifact ${path} is neither a file nor a directory`);
  const hash = createHash('sha256');
  let entries = 0;
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (++entries > 200_000) throw new Error('Artifact has too many files to identify');
      const full = join(dir, name), at = rel ? `${rel}/${name}` : name, st = lstatSync(full);
      if (st.isSymbolicLink()) hash.update(`l\0${at}\0${readlinkSync(full)}\0`);
      else if (st.isDirectory()) { hash.update(`d\0${at}\0`); walk(full, at); }
      else if (st.isFile()) hash.update(`f\0${at}\0${fileSha256(full)}\0`);
    }
  };
  walk(path, '');
  return hash.digest('hex');
}

export function recordDeviceEvidence(db: Db, evidence: DeviceEvidence, receiptPath: string | null): void {
  const parsed = DeviceEvidenceSchema.parse(evidence);
  db.prepare(`INSERT OR REPLACE INTO device_evidence (id, project_id, task_id, sha, requirement, status, evidence, receipt_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(parsed.requestId ?? `e-${randomUUID()}`, parsed.projectId, parsed.taskId, parsed.commit,
    parsed.requirement, parsed.status.overall, JSON.stringify(parsed), receiptPath, Date.now());
}

export interface StoredEvidence { evidence: DeviceEvidence; receiptPath: string | null; recordedAt: number }
export function deviceEvidence(db: Db, filter: { taskId?: string | null; projectId?: string | null; limit?: number } = {}): StoredEvidence[] {
  const where: string[] = [], args: string[] = [];
  if (filter.taskId) { where.push('task_id = ?'); args.push(filter.taskId); }
  if (filter.projectId) { where.push('project_id = ?'); args.push(filter.projectId); }
  const rows = db.prepare(`SELECT evidence, receipt_path, created_at FROM device_evidence ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...args, Math.min(200, filter.limit ?? 20)) as { evidence: string; receipt_path: string | null; created_at: number }[];
  return rows.flatMap(row => {
    const parsed = DeviceEvidenceSchema.safeParse(JSON.parse(row.evidence));
    return parsed.success ? [{ evidence: parsed.data, receiptPath: row.receipt_path, recordedAt: row.created_at }] : [];
  });
}

/** Evidence a provider attached to its result (`result.data.evidence`), if it is well-formed. */
export function evidenceOf(result: object): DeviceEvidence | null {
  const data = (result as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || !('evidence' in data)) return null;
  const parsed = DeviceEvidenceSchema.safeParse((data as { evidence: unknown }).evidence);
  return parsed.success ? parsed.data : null;
}

/** One line for text surfaces (CLI, MCP): the three statuses, never collapsed into one "passed". */
export function evidenceLine(e: DeviceEvidence): string {
  const device = e.device ? `${e.device.model}, ${e.device.runtime} (${e.device.kind})` : 'no device';
  const code = e.status.code === 'passed' ? 'code passed' : 'code checks not run';
  const sim = `simulator ${e.status.simulator === 'not-run' ? 'not run' : e.status.simulator}`;
  const physical = `physical device ${e.status.physical}`;
  const artifact = e.artifact ? ` artifact sha256 ${e.artifact.sha256.slice(0, 12)}${e.artifact.source === 'reused' ? ' (reused)' : ''}` : '';
  return `${e.status.overall.toUpperCase()} ${e.commit?.slice(0, 12) ?? 'uncommitted'}: ${code}, ${sim}, ${physical} [${device}]${artifact}`;
}
