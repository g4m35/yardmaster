import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { yardHome } from './paths.ts';
import type { ProcessIdentity, TerminateOptions, TerminateResult } from './proc.ts';

const execFileP = promisify(execFile);
export const PROCESS_OWNER_ENV = 'YARDMASTER_PROCESS_OWNER';
const PROBE_ENV = 'YARDMASTER_PROCESS_LOOKUP_PROBE';
const MAX_LOOKUP_BYTES = 64 * 1024 * 1024;
const MAX_CENSUS_BYTES = 4 * 1024 * 1024;
const LOOKUP_TIMEOUT_MS = 2000;
const MARKER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const launchTimes = new Map<string, number>();

/** A random inherited tag identifies cooperative descendants even after setsid/reparenting.
 * This is ownership evidence, not hostile-child containment: a child can clear its environment or hide it from OS inspection.
 * The private receipt binds the tag to the recorded leader identity across supervisor restarts.
 */
export interface ProcessOwnership extends ProcessIdentity { marker: string; uid: number; launchedAt?: number }

function directory(): string {
  const dir = join(yardHome(), 'process-owners');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Error('Process ownership directory must be private, owned by this user, and not a symlink.');
  return dir;
}

export function processOwnershipMarker(): string {
  const launchedAt = Date.now();
  directory(); // Refuse unsafe storage before creating a child.
  const marker = randomUUID();
  launchTimes.set(marker, launchedAt);
  // Failed spawns never reach receipt cleanup. Bound this optimization; an evicted timestamp only
  // broadens inspection, while a recorded receipt preserves the pre-spawn time across restart.
  if (launchTimes.size > 4096) launchTimes.delete(launchTimes.keys().next().value!);
  return marker;
}

export function inheritedProcessOwnership(env: NodeJS.ProcessEnv, marker: string): string {
  const ancestors = env[PROCESS_OWNER_ENV]?.split(':') ?? [];
  if (ancestors.length > 31 || ancestors.some(value => !MARKER.test(value))) throw new Error('Invalid or excessive inherited process ownership chain.');
  return [...ancestors, marker].join(':');
}

export function recordProcessOwnership(id: ProcessIdentity, marker: string): ProcessOwnership {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Process ownership inspection is unsupported on this platform.');
  const receipt: ProcessOwnership = { ...id, marker, uid, launchedAt: launchTimes.get(marker) };
  const dir = directory(), file = join(dir, `${id.pid}.json`), temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd);
    // Never replace an older unresolved receipt after PID reuse.
    linkSync(temporary, file);
    const parent = openSync(dir, 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { closeSync(fd); rmSync(temporary, { force: true }); }
  return receipt;
}

export function readProcessOwnership(id: ProcessIdentity): ProcessOwnership | null {
  const file = join(directory(), `${id.pid}.json`);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Process ownership receipt cannot be read safely.'); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > 2048) throw new Error('Unsafe process ownership receipt.');
    const r = JSON.parse(readFileSync(fd, 'utf8')) as ProcessOwnership;
    if (r.pid !== id.pid || r.startedAt !== id.startedAt || r.uid !== process.getuid?.() ||
        typeof r.marker !== 'string' || !MARKER.test(r.marker) ||
        (r.launchedAt !== undefined && (!Number.isSafeInteger(r.launchedAt) || r.launchedAt < 0))) throw new Error('Process ownership receipt does not match the recorded identity.');
    return r;
  } finally { closeSync(fd); }
}

export function forgetProcessOwnership(receipt: ProcessOwnership): void {
  // A reused leader PID can already have a different receipt. Never remove its ownership evidence.
  const current = readProcessOwnership(receipt);
  if (current?.marker === receipt.marker) rmSync(join(directory(), `${receipt.pid}.json`), { force: true });
  launchTimes.delete(receipt.marker);
}

interface MarkedProcess { pid: number; startedAt: number }
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
interface CensusProcess extends MarkedProcess { uid: number; state: string }
const pendingCensus = new Map<string, Promise<CensusProcess[]>>();

/** Coalesce requests queued in the same event-loop turn, before the OS snapshot starts. Remove
 * the pending entry before exec: a later request can never reuse a snapshot already in flight or
 * completed. In particular, the second quiet check always observes a newly started census.
 */
function census(uid: number, env: NodeJS.ProcessEnv): Promise<CensusProcess[]> {
  const key = JSON.stringify([uid, env.PATH ?? '']);
  const queued = pendingCensus.get(key);
  if (queued) return queued;
  const request = new Promise<CensusProcess[]>((resolve, reject) => {
    setImmediate(() => {
      pendingCensus.delete(key);
      void readCensus(uid, env).then(resolve, reject);
    });
  });
  pendingCensus.set(key, request);
  return request;
}

async function readCensus(uid: number, env: NodeJS.ProcessEnv): Promise<CensusProcess[]> {
  // macOS ps has effective UID 0 while inspecting; its real UID remains the caller's.
  const call = execFileP('ps', ['-U', String(uid), '-o', 'pid=,ruid=,stat=,lstart='], {
    env, encoding: 'utf8', timeout: LOOKUP_TIMEOUT_MS, maxBuffer: MAX_CENSUS_BYTES,
  });
  const inspectorPid = call.child.pid;
  const { stdout } = await call;
  let inspectedSelf = false;
  const result: CensusProcess[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) throw new Error('Process identity census could not be parsed.');
    const pid = Number(m[1]), realUid = Number(m[2]), startedAt = Date.parse(m[4]!);
    if (!Number.isSafeInteger(pid) || !Number.isFinite(startedAt)) throw new Error('Process identity census has invalid timestamps.');
    if (pid === inspectorPid && realUid === uid) inspectedSelf = true;
    if (realUid === uid && pid !== inspectorPid) result.push({ pid, uid: realUid, startedAt, state: m[3]! });
  }
  if (!inspectedSelf) throw new Error('Process identity census could not be verified.');
  return result;
}

/** Read only identity metadata for the user's processes first. A descendant cannot predate the
 * actual pre-spawn timestamp (allow two seconds for ps rounding). Null/legacy timestamps inspect
 * every candidate instead of guessing from the later receipt-write time. Never cache a census:
 * each quiet observation starts a distinct OS snapshot after the previous observation completed.
 */
async function candidates(receipt: ProcessOwnership, env: NodeJS.ProcessEnv): Promise<number[]> {
  const processes = await census(receipt.uid, env);
  const stamp = receipt.launchedAt ?? launchTimes.get(receipt.marker);
  const times = [receipt.startedAt, stamp].filter((time): time is number => time !== null && time !== undefined && Number.isFinite(time) && time <= Date.now());
  const earliest = times.length ? Math.min(...times) - 2000 : -Infinity;
  const launchedHere = launchTimes.has(receipt.marker);
  const result: number[] = [];
  for (const p of processes) {
    // This supervisor/parent predate tags created here. During historical recovery they could
    // themselves retain the old tag; inspect them and let the self-signal guard hold recovery.
    if (p.pid <= 1 || (launchedHere && (p.pid === process.pid || p.pid === process.ppid)) || p.state.includes('Z') || p.startedAt < earliest) continue;
    result.push(p.pid);
    if (result.length > 4096) throw new Error('Inherited process ownership lookup exceeded its process bound.');
  }
  return result;
}

/** Process environments are read only into bounded transient memory. Never return, persist, or log them.
 * The lookup's own random probe verifies that ps actually emitted environments, rather than silently
 * accepting an unsupported flag. Same-user UID and the random tag are checked for every signal target.
 */
async function markedProcesses(receipt: ProcessOwnership, target?: MarkedProcess): Promise<MarkedProcess[]> {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Inherited process ownership inspection is unsupported on this platform.');
  const probe = randomUUID();
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', [PROBE_ENV]: probe };
  delete env[PROCESS_OWNER_ENV];
  let stdout: string;
  let selected: Set<number>;
  try {
    selected = new Set(target ? [target.pid] : await candidates(receipt, env));
    // A complete identity census with no possible descendant needs no environment access.
    if (!selected.size) return [];
    // Fixed shell program; only validated numeric PID data enters argv. The shell execs ps with
    // its own PID explicitly selected, so its random environment probe is always inspected.
    const args = ['-c', 'exec ps eww -p "$$${1:+,$1}" -o pid=,ruid=,stat=,lstart=,command=', 'ym-owned-lookup', [...selected].join(',')];
    ({ stdout } = await execFileP('/bin/sh', args, { env, encoding: 'utf8', timeout: LOOKUP_TIMEOUT_MS, maxBuffer: MAX_LOOKUP_BYTES }));
  }
  catch {
    if (target) { try { process.kill(target.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return []; } }
    throw new Error('Could not inspect inherited process ownership.');
  }
  if (!stdout.includes(`${PROBE_ENV}=${probe}`)) throw new Error('Process environment inspection could not be verified.');
  const result: MarkedProcess[] = [];
  const tag = new RegExp(`(?:^|\\s)${PROCESS_OWNER_ENV}=([0-9a-f:-]+)(?=\\s|$)`, 'g');
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(line);
    if (!m || !selected.has(Number(m[1]))) continue;
    const pid = Number(m[1]);
    if (m[3]!.includes('Z')) continue;
    // Unrelated same-user services can have intentionally hidden/empty environments (e.g. macOS
    // Spotlight). Only positive, OS-visible marker evidence establishes descendant ownership.
    if (Number(m[2]) !== receipt.uid) continue;
    if (![...m[5]!.matchAll(tag)].some(match => match[1]?.split(':').includes(receipt.marker))) continue;
    const startedAt = Date.parse(m[4]!);
    if (pid <= 1 || pid === process.pid || !Number.isFinite(startedAt)) throw new Error('Invalid inherited process ownership evidence.');
    if (target && (pid !== target.pid || startedAt !== target.startedAt)) continue;
    result.push({ pid, startedAt });
    if (result.length > 4096) throw new Error('Inherited process ownership lookup exceeded its process bound.');
  }
  return result;
}

/** Recheck exact PID/start/tag immediately before each individual signal. Re-scan until quiet so a
 * descendant forked during shutdown is included. No unrelated process group is ever signaled here.
 * POSIX lacks a portable atomic signal-by-identity primitive; this is not protection against hostile PID races.
 */
export async function terminateMarkedProcesses(receipt: ProcessOwnership, opts: TerminateOptions = {}): Promise<TerminateResult> {
  let lastSignal: 'SIGTERM' | 'SIGKILL' | undefined;
  try {
    for (const [signal, duration] of [['SIGTERM', opts.graceMs ?? 3000], ['SIGKILL', opts.killWaitMs ?? 2000]] as const) {
      const deadline = Date.now() + duration;
      const signaled = new Set<string>();
      for (;;) {
        const found = await markedProcesses(receipt);
        if (!found.length) {
          // A new asynchronous OS census after an event-loop yield is a fresh observation.
          // The fixed 25 ms sleep added latency to every Git utility without strengthening
          // either snapshot. Nonempty TERM/KILL polling retains its configured wait below.
          await new Promise<void>(resolve => setImmediate(resolve));
          if (!(await markedProcesses(receipt)).length) return lastSignal ? { status: 'terminated', signal: lastSignal } : { status: 'exited' };
        }
        for (const target of found) {
          if (Date.now() >= deadline && signaled.size > 0) break;
          const key = `${target.pid}:${target.startedAt}`;
          if (signaled.has(key) || !(await markedProcesses(receipt, target)).length) continue;
          try { process.kill(target.pid, signal); lastSignal = signal; signaled.add(key); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Could not stop an inherited owned process.'); }
        }
        if (Date.now() >= deadline) break;
        await wait(opts.pollMs ?? 25);
      }
    }
    return { status: 'survived', signal: lastSignal, reason: 'Inherited owned processes remain alive after bounded cleanup.' };
  } catch (error) { return { status: 'unverified', reason: (error as Error).message }; }
}

export function combineProcessCleanup(group: TerminateResult, marked: TerminateResult): TerminateResult {
  if (['unverified', 'survived'].includes(group.status)) return group;
  if (['unverified', 'survived'].includes(marked.status)) return marked;
  if (marked.status === 'terminated') return marked;
  return group;
}
