import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, rmSync, writeSync } from 'node:fs';
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
  /** Files removed instead of kept, such as a binary that contained a declared credential. */
  omitted: z.array(z.object({ path: Text(4096), reason: Text(300) })).max(100).default([]),
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

/** Whether a provider result carries device evidence (`result.data.evidence`), and whether it is well-formed. */
export function evidenceState(result: object): { kind: 'absent' } | { kind: 'invalid' } | { kind: 'valid'; evidence: DeviceEvidence } {
  const data = (result as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || !('evidence' in data)) return { kind: 'absent' };
  const parsed = DeviceEvidenceSchema.safeParse((data as { evidence: unknown }).evidence);
  return parsed.success ? { kind: 'valid', evidence: parsed.data } : { kind: 'invalid' };
}
export function evidenceOf(result: object): DeviceEvidence | null {
  const state = evidenceState(result);
  return state.kind === 'valid' ? state.evidence : null;
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

const LEVELS = { simulator: 0, physical: 1 } as const;
export type DeviceLevel = keyof typeof LEVELS;
const LevelSchema = z.object({ requires: z.enum(['simulator', 'physical']) });

/** The level the request (per-check input) or project configuration asks for, never what the provider reports. */
export function requiredDeviceLevel(input: unknown, providerOptions: unknown): DeviceLevel | null {
  for (const source of [input, providerOptions]) {
    const parsed = LevelSchema.safeParse(source);
    if (parsed.success) return parsed.data.requires;
  }
  return null;
}

/**
 * Why evidence does not establish a pass of `required` on commit `sha`, or null when it does. A pass must be
 * consistent with the device it names: a physical pass needs a physical device, and a simulator never stands in.
 */
export function evidenceProblem(e: DeviceEvidence, sha: string | null, required: DeviceLevel): string | null {
  if (e.commit !== sha) return `it is bound to ${e.commit ?? 'no commit'}, not ${sha}`;
  if (LEVELS[e.requirement] < LEVELS[required]) return `it answers a ${e.requirement} requirement, but this check requires ${required}`;
  if (e.status.physical === 'passed' && e.device?.kind !== 'physical') return `it claims a physical-device pass on ${e.device ? `a ${e.device.kind}` : 'no device'}`;
  if (e.status.simulator === 'passed' && !e.device) return 'it claims a simulator pass without naming a device';
  if (e.status.overall !== 'passed') return e.summary.trim() || `its overall status is ${e.status.overall}`;
  if (required === 'physical' && e.status.physical !== 'passed') return `physical device ${e.status.physical}; a simulator pass does not satisfy a physical-device requirement`;
  if (required === 'simulator' && e.status.simulator !== 'passed' && e.status.physical !== 'passed') return 'no device check passed';
  return null;
}

const REDACTED = Buffer.from('[redacted]');
const needlesOf = (secrets: string[]) => [...new Set(secrets.filter(Boolean))].map(secret => Buffer.from(secret));

/** Every occurrence of every secret (overlaps included), merged into disjoint spans: union, longest coverage. */
function secretSpans(buf: Buffer, needles: Buffer[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const needle of needles) for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + 1)) spans.push([at, at + needle.length]);
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/** In-memory form of scrubFile: union of all matches, so overlapping secrets never leave a fragment. */
export function redactText(text: string, secrets: string[]): string {
  const needles = needlesOf(secrets);
  if (!needles.length) return text;
  const buf = Buffer.from(text);
  const parts: Buffer[] = [];
  let at = 0;
  for (const [start, end] of secretSpans(buf, needles)) { parts.push(buf.subarray(at, start), REDACTED); at = end; }
  parts.push(buf.subarray(at));
  return Buffer.concat(parts).toString('utf8');
}

/**
 * Replace every occurrence of the given secrets in a file of any size, streaming in chunks. Matches are merged
 * into spans first, so overlapping secrets are redacted as one. Bytes after `limit` (the last longest-secret - 1
 * bytes) may start a match that continues in the next chunk, and a span that crosses `limit` may still grow, so
 * both are carried into the next round. Returns whether anything was replaced.
 */
export function scrubFile(file: string, secrets: string[], chunkBytes = 1024 * 1024): boolean {
  const needles = needlesOf(secrets);
  if (!needles.length) return false;
  const keep = Math.max(...needles.map(n => n.length)) - 1;
  const temp = `${file}.scrub-${process.pid}`;
  const input = openSync(file, 'r'), output = openSync(temp, 'w', 0o600);
  let changed = false;
  try {
    const chunk = Buffer.alloc(Math.max(1, chunkBytes));
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = readSync(input, chunk, 0, chunk.length, null);
      const buf = Buffer.concat([carry, chunk.subarray(0, n)]);
      const last = n === 0;
      const limit = last ? buf.length : Math.max(0, buf.length - keep);
      let at = 0, emitTo = limit;
      for (const [start, end] of secretSpans(buf, needles)) {
        // Unsettled: it starts in the carried tail, or it reaches past it and might still overlap the next match.
        if (!last && (start >= limit || end > limit)) { emitTo = Math.min(start, limit); break; }
        writeSync(output, buf.subarray(at, start)); writeSync(output, REDACTED);
        at = end; changed = true;
      }
      emitTo = Math.max(at, emitTo);
      writeSync(output, buf.subarray(at, emitTo));
      if (last) break;
      carry = Buffer.from(buf.subarray(emitTo));
    }
  } finally { closeSync(input); closeSync(output); }
  if (changed) renameSync(temp, file); else rmSync(temp, { force: true });
  return changed;
}

/** Whether any secret occurs in the file, streaming with an overlap so a match across chunks is found. */
export function fileContainsSecret(file: string, secrets: string[], chunkBytes = 1024 * 1024): boolean {
  const needles = needlesOf(secrets);
  if (!needles.length) return false;
  const keep = Math.max(...needles.map(n => n.length)) - 1;
  const input = openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(Math.max(1, chunkBytes));
    let carry = Buffer.alloc(0);
    for (;;) {
      const n = readSync(input, chunk, 0, chunk.length, null);
      if (n === 0) return false;
      const buf = Buffer.concat([carry, chunk.subarray(0, n)]);
      if (needles.some(needle => buf.includes(needle))) return true;
      carry = Buffer.from(buf.subarray(Math.max(0, buf.length - keep)));
    }
  } finally { closeSync(input); }
}

const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|heic|webp|tiff?|mp4|mov|zip|gz|ipa|xcresult|pdf|sqlite|db)$/i;
/** Text is scrubbed in place; anything else would be corrupted by substitution (PNG lengths and CRCs, archives). */
export function isTextFile(file: string): boolean {
  if (BINARY_EXTENSIONS.test(file)) return false;
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(8192);
    const n = readSync(fd, head, 0, head.length, 0);
    return !head.subarray(0, n).includes(0);
  } finally { closeSync(fd); }
}

/**
 * Make an evidence file safe to keep: text is redacted; a binary is kept byte-identical when it holds no declared
 * credential and otherwise removed, so evidence never contains a corrupted or unscrubbed binary.
 */
export function sanitizeEvidenceFile(file: string, secrets: string[]): 'kept' | 'scrubbed' | 'omitted' {
  if (!secrets.filter(Boolean).length) return 'kept';
  if (isTextFile(file)) return scrubFile(file, secrets) ? 'scrubbed' : 'kept';
  if (!fileContainsSecret(file, secrets)) return 'kept';
  rmSync(file, { force: true });
  return 'omitted';
}
