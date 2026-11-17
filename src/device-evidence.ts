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
    /** A simulator's UDID; for a physical device, its stable hashed key (`d-…`), never the hardware UDID. */
    runtime: Text(200), runtimeIdentifier: Text(300), udid: Text(100), createdByYardmaster: z.boolean(),
  }).nullable(),
  /**
   * The app as found on a physical device: its version, and whether this run installed it. With no `artifact`, the
   * run tested a copy someone else installed, which says nothing about this commit's code.
   */
  deviceApp: z.object({ bundleId: Text(300), name: Text(200).nullable(), version: Text(100).nullable(), build: Text(100).nullable(), installedByRun: z.boolean() })
    .nullable().default(null),
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
/** The request a piece of evidence must belong to: this dispatch, and its project and task when known. */
export interface EvidenceExpectation { requestId: string; projectId?: string | null; taskId?: string | null }

/** Why evidence was not produced for this request, or null. Earlier evidence for the same commit does not count. */
export function bindingProblem(e: DeviceEvidence, expect: EvidenceExpectation): string | null {
  if (e.requestId !== expect.requestId) return `it belongs to request ${e.requestId ?? 'none'}, not this check's request ${expect.requestId}`;
  if (expect.projectId && e.projectId !== expect.projectId) return `it names project ${e.projectId ?? 'none'}, not ${expect.projectId}`;
  if (expect.taskId && e.taskId !== expect.taskId) return `it names task ${e.taskId ?? 'none'}, not ${expect.taskId}`;
  return null;
}

/** Well-formed evidence bound to this request, for recording; anything else is not persisted. */
export function boundEvidence(result: object, expect: EvidenceExpectation): DeviceEvidence | null {
  const state = evidenceState(result);
  return state.kind === 'valid' && !bindingProblem(state.evidence, expect) ? state.evidence : null;
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
  const artifact = e.artifact ? ` artifact sha256 ${e.artifact.sha256.slice(0, 12)}${e.artifact.source === 'reused' ? ' (reused)' : ''}`
    : e.deviceApp ? ` installed app ${e.deviceApp.version ?? '?'} (${e.deviceApp.build ?? '?'}), not built from this commit` : '';
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
  if (e.status.physical === 'passed' && !e.artifact && e.deviceApp && !e.deviceApp.installedByRun) {
    return `it tested the copy of ${e.deviceApp.bundleId} already installed on the device${e.deviceApp.version ? ` (${e.deviceApp.version}${e.deviceApp.build ? ` build ${e.deviceApp.build}` : ''})` : ''}, not a build of this commit`;
  }
  if (e.status.physical === 'passed' && e.artifact && (!sha || e.artifact.builtFromCommit !== sha)) {
    return 'the physical-device artifact was not built from this commit; a prebuilt app is smoke evidence only';
  }
  if (required === 'simulator' && e.status.simulator !== 'passed' && e.status.physical !== 'passed') return 'no device check passed';
  return null;
}

const REDACTED = Buffer.from('[redacted]');
const needlesOf = (secrets: string[]) => [...new Set(secrets.filter(Boolean))].map(secret => Buffer.from(secret));

/** Every occurrence of every secret, overlapping and adjacent ones merged: the union scrubFile redacts too. */
function secretSpans(buf: Buffer, needles: Buffer[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const needle of needles) for (let at = buf.indexOf(needle); at >= 0; at = buf.indexOf(needle, at + 1)) spans.push([at, at + needle.length]);
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
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
 * Replace every occurrence of the given secrets in a file of any size, streaming in chunks. Overlapping and adjacent
 * matches form one redacted run (union of all matches). Memory is one chunk plus the longest secret, and a coverage
 * mask of the same size: only the last (longest - 1) bytes are carried, since a match starting there may continue
 * in the next chunk. A run still open at that point is kept as a position (`coveredUntil`), not as bytes, so a long
 * stretch of overlapping matches is redacted as it streams. Returns whether anything was replaced.
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
    let base = 0;            // stream offset of buf[0]
    let coveredUntil = 0;    // end of the furthest match seen (stream offset); may reach into the carried tail
    let inRun = false;       // the byte before `base` was redacted, so the current run's marker is already written
    for (;;) {
      const n = readSync(input, chunk, 0, chunk.length, null);
      const buf = Buffer.concat([carry, chunk.subarray(0, n)]);
      const last = n === 0;
      const settled = last ? buf.length : Math.max(0, buf.length - keep);
      const mask = new Uint8Array(buf.length);
      if (coveredUntil > base) mask.fill(1, 0, Math.min(buf.length, coveredUntil - base));
      // Matches starting in the settled part lie wholly in `buf`; later ones are found again from the carried tail.
      for (const needle of needles) {
        let filled = 0;
        for (let at = buf.indexOf(needle); at >= 0 && at < settled; at = buf.indexOf(needle, at + 1)) {
          const end = at + needle.length;
          mask.fill(1, Math.max(at, filled), end);
          filled = end;
          coveredUntil = Math.max(coveredUntil, base + end);
        }
      }
      for (let i = 0; i < settled;) {
        const run = mask.indexOf(1, i);
        const plainEnd = run < 0 || run > settled ? settled : run;
        if (plainEnd > i) { writeSync(output, buf.subarray(i, plainEnd)); inRun = false; i = plainEnd; continue; }
        const stop = mask.indexOf(0, i);
        const runEnd = stop < 0 || stop > settled ? settled : stop;
        if (!inRun) { writeSync(output, REDACTED); changed = true; }
        inRun = true;
        i = runEnd;
      }
      if (last) break;
      carry = Buffer.from(buf.subarray(settled));
      base += settled;
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

const TEXT_EXTENSIONS = /\.(txt|log|out|err|xml|json|jsonl|html?|csv|tsv|md|ya?ml|tap|junit|plist|ips|crash)$/i;
/**
 * Only files confidently identified as text are rewritten: an allowlisted text extension, valid UTF-8 across the
 * whole file and no NUL byte. Anything else (PNGs, protobuf reports, archives) would be corrupted by substitution.
 */
export function isTextFile(file: string, chunkBytes = 1024 * 1024): boolean {
  if (!TEXT_EXTENSIONS.test(file)) return false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const fd = openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(chunkBytes);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) { decoder.decode(); return true; }
      const part = chunk.subarray(0, n);
      if (part.includes(0)) return false;
      decoder.decode(part, { stream: true });
    }
  } catch { return false; } finally { closeSync(fd); }
}

/**
 * Make an evidence file safe to keep: confident text is redacted; anything else is kept byte-identical when it
 * holds no declared credential and otherwise removed, so evidence never contains a corrupted or unscrubbed file.
 */
export function sanitizeEvidenceFile(file: string, secrets: string[]): 'kept' | 'scrubbed' | 'omitted' {
  if (!secrets.filter(Boolean).length) return 'kept';
  if (isTextFile(file)) return scrubFile(file, secrets) ? 'scrubbed' : 'kept';
  if (!fileContainsSecret(file, secrets)) return 'kept';
  rmSync(file, { force: true });
  return 'omitted';
}
