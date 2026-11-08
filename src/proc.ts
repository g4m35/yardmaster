import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const execFileP = promisify(execFile);

/**
 * Git variables that, when inherited from a parent agent or hook, silently redirect a child's
 * git commands into another checkout. This is the root cause of "parallel worktree agents commit
 * to each other's branches" reports, so every child process gets them stripped.
 */
const LEAKY_GIT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of LEAKY_GIT_VARS) delete env[k];
  // Nested Claude Code sessions refuse to start when they think they are inside another session.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // The hub's admin token never reaches agents or check commands. The hub address goes too: a child that finds a hub
  // address but no token would call that hub with this machine's own token, so children find the hub (and its token)
  // through the owner-only files in the Yardmaster home instead.
  delete env.YARDMASTER_TOKEN;
  delete env.YARDMASTER_HUB;
  return { ...env, ...extra };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
}

export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const scope = utilityScope.getStore();
  if (scope) return scopedUtility(scope, cmd, args, opts);
  return runUnscoped(cmd, args, opts);
}

async function runUnscoped(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  if (opts.input !== undefined) return runWithInput(cmd, args, opts);
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? cleanEnv(),
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message: string };
    if (e.code === 'ENOENT') throw new Error(`Command not found: ${cmd}`);
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message };
  }
}

function runWithInput(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(opts.input);
  });
}

// ---------------- owned process lifetime ----------------

/** Recorded identity of a process Yardmaster launched as its own process-group leader. */
export interface ProcessIdentity {
  pid: number;
  /** Epoch ms from `ps lstart` (one-second resolution); null when it could not be read. */
  startedAt: number | null;
}

/** What a registry learns about an owned child, the moment it exists. */
export interface OwnedProcessInfo extends ProcessIdentity {
  /** Every owned child leads its own process group, so the group id equals the pid. */
  pgid: number;
  command: string;
  args: readonly string[];
}

/**
 * - exited: nothing in the group was alive, no signal was sent.
 * - terminated: the group was ours and is now gone (`signal` is the last one that was needed).
 * - unverified: something alive matches the pid/group, but it could not be proven to be ours; it was not signaled.
 * - survived: ours, but still alive after SIGKILL and the wait (uninterruptible I/O, EPERM). Replacement work must not
 *   start against the same worktree.
 */
export type TerminateStatus = 'exited' | 'terminated' | 'unverified' | 'survived';
export interface TerminateResult {
  status: TerminateStatus;
  signal?: 'SIGTERM' | 'SIGKILL';
  reason?: string;
}

export interface TerminateOptions {
  /** Time between SIGTERM and SIGKILL. */
  graceMs?: number;
  /** Time to wait for the group to disappear after SIGKILL before reporting `survived`. */
  killWaitMs?: number;
  pollMs?: number;
}

const DEFAULT_TERM_GRACE_MS = 3000;
const DEFAULT_KILL_WAIT_MS = 2000;
const DEFAULT_EXIT_GRACE_MS = 3000;
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
/** `ps lstart` has one-second resolution; this is the tolerance existing orphan recovery already used. */
const START_TOLERANCE_MS = 2000;

function signalable(pid: number | null | undefined): pid is number {
  // pid 0/1 or our own process would signal far more than one agent (kill(-1) hits every process we own).
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

/**
 * Whether any process is still in this process group. A group id cannot be handed to a new process while any member
 * of the group lives (POSIX; enforced by both XNU and Linux pid allocation), so while this is true, signaling the group
 * reaches only the original group's members. Zombies count until they are reaped.
 */
export function groupAlive(pgid: number): boolean {
  if (!signalable(pgid) || process.platform === 'win32') return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitGroupGone(pgid: number, ms: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return true;
}

async function escalate(pgid: number, opts: TerminateOptions): Promise<TerminateResult> {
  const poll = opts.pollMs ?? 25;
  if (!groupAlive(pgid)) return { status: 'exited' };
  signalGroup(pgid, 'SIGTERM');
  if (await waitGroupGone(pgid, opts.graceMs ?? DEFAULT_TERM_GRACE_MS, poll)) return { status: 'terminated', signal: 'SIGTERM' };
  signalGroup(pgid, 'SIGKILL');
  if (await waitGroupGone(pgid, opts.killWaitMs ?? DEFAULT_KILL_WAIT_MS, poll)) return { status: 'terminated', signal: 'SIGKILL' };
  return { status: 'survived', signal: 'SIGKILL', reason: `process group ${pgid} is still alive after SIGKILL` };
}

/**
 * Stops a process group this process spawned (detached, so the group id is the child's pid) and still holds the
 * ChildProcess for: SIGTERM, a grace period, SIGKILL, then a bounded wait until the whole group is gone. Signals are
 * sent only while the group exists, never to a lone pid, so a recycled pid is never hit.
 */
export function terminateOwnedGroup(pgid: number, opts: TerminateOptions = {}): Promise<TerminateResult> {
  if (!signalable(pgid)) return Promise.resolve({ status: 'unverified', reason: `refusing to signal pid ${pgid}` });
  if (process.platform === 'win32') {
    // No process groups: only the leader can be stopped, and its descendants are not tracked.
    try {
      process.kill(pgid, 'SIGKILL');
    } catch {
      // already gone
    }
    return Promise.resolve({ status: 'unverified', reason: 'process groups are not supported on Windows; descendants are not tracked' });
  }
  return escalate(pgid, opts);
}

interface PsRow {
  pid: number;
  pgid: number;
  startedAt: number | null;
}

async function listProcesses(): Promise<PsRow[] | null> {
  const r = await runUnscoped('ps', ['-A', '-o', 'pid=,pgid=,lstart='], { timeoutMs: 10_000 }).catch(() => null);
  if (!r || r.code !== 0) return null;
  const rows: PsRow[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const t = Date.parse(m[3]!);
    rows.push({ pid: Number(m[1]), pgid: Number(m[2]), startedAt: Number.isNaN(t) ? null : t });
  }
  return rows;
}

/**
 * Restart recovery for a process recorded by an earlier Yardmaster process (so there is no ChildProcess handle).
 * Signals only when the recorded identity is proven:
 * - the leader is alive, still leads its group, and its start time matches the record; or
 * - the leader has exited and every remaining member of its group started no earlier than the recorded leader
 *   (descendants keep the group id reserved, so it cannot have been recycled while they live).
 * Anything else (unknown start time, a pid now used by a non-leader, a member older than the record) is reported
 * `unverified` and left alone; callers should hold the worktree and ask for attention rather than reschedule.
 *
 * Residual limit: if the original group fully exited, the pid wrapped around to a new group leader, and that leader
 * also exited leaving children started after the record, those children would pass the descendant check. This needs
 * pid wraparound plus a matching orphaned group and is not distinguished.
 */
export async function terminateRecordedProcess(id: ProcessIdentity, opts: TerminateOptions = {}): Promise<TerminateResult> {
  if (!signalable(id.pid)) return { status: 'unverified', reason: `refusing to signal pid ${id.pid}` };
  if (process.platform === 'win32') return { status: 'unverified', reason: 'process identity is not verifiable on Windows' };
  const rows = await listProcesses();
  if (!rows) return { status: 'unverified', reason: 'could not list processes' };
  const leader = rows.find((r) => r.pid === id.pid);
  const members = rows.filter((r) => r.pgid === id.pid);
  if (!members.length) {
    if (leader) return { status: 'unverified', reason: `pid ${id.pid} is alive but no longer leads its own process group (reused pid)` };
    return { status: 'exited' };
  }
  if (id.startedAt === null) return { status: 'unverified', reason: 'no recorded start time for this process' };
  const recorded = id.startedAt;
  if (leader && leader.pgid === id.pid) {
    if (leader.startedAt === null || Math.abs(leader.startedAt - recorded) > START_TOLERANCE_MS) {
      return { status: 'unverified', reason: `pid ${id.pid} started at a different time than recorded (reused pid)` };
    }
  } else if (members.some((m) => m.startedAt === null || m.startedAt < recorded - START_TOLERANCE_MS)) {
    return { status: 'unverified', reason: `process group ${id.pid} has a member older than the recorded process` };
  }
  return escalate(id.pid, opts);
}

export type OwnedEnd = 'exit' | 'timeout' | 'aborted' | 'stopped' | 'spawn_failed' | 'hook_failed';

export interface OwnedRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell?: boolean;
  /** Written to stdin, which is then closed. Without it stdin is ignored. */
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** After the leader exits, how long a descendant may keep stdout/stderr open before the group is stopped. */
  exitGraceMs?: number;
  termGraceMs?: number;
  killWaitMs?: number;
  /**
   * Called once the child has a pid, with its start identity, while the lifetime guard is already in place: exits,
   * aborts and timeouts are handled during the await. A throw/rejection, or not settling within `hookTimeoutMs`,
   * stops the child (an unregistered child must never keep running) and ends the run as `hook_failed`.
   */
  onSpawn?: (proc: OwnedProcessInfo) => void | Promise<void>;
  hookTimeoutMs?: number;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface OwnedRunResult {
  end: OwnedEnd;
  /** Leader exit code, null when it was ended by a signal or never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  pid: number | null;
  /** Start identity of the leader (only read when `onSpawn` is given). */
  startedAt: number | null;
  launchedAt: number;
  endedAt: number;
  /** The leader exited but a descendant held its output pipes open past `exitGraceMs`. */
  pipeHeld: boolean;
  /** Cleanup of the whole group after the run, including normal exits. */
  reap: TerminateResult;
  /** True when nothing from this run is still alive. False means do not start overlapping work. */
  reaped: boolean;
  /** Spawn, hook or stop detail. */
  error: string;
}

export interface OwnedProcess {
  /** Stop the run (`stopped`) unless it already ended or another stop won. */
  stop(reason: string): void;
  readonly done: Promise<OwnedRunResult>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function abortText(signal: AbortSignal): string {
  const r: unknown = signal.reason;
  if (typeof r === 'string') return r;
  if (r instanceof Error && r.name !== 'AbortError') return r.message;
  return 'canceled';
}

/**
 * Spawns one child as its own process-group leader and owns its whole lifetime: abort, timeout, spawn/stdin errors,
 * a registration hook, the exit-with-pipes-held fallback, and process-group cleanup on every path including a
 * normal exit. `done` never rejects and resolves only after the group cleanup finished (or reported `survived`).
 */
export function startOwnedProcess(command: string, args: readonly string[], opts: OwnedRunOptions): OwnedProcess {
  const launchedAt = Date.now();
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  let child: ChildProcess | null = null;
  let stopEnd: OwnedEnd | null = null;
  let stopDetail = '';
  let terminating: Promise<TerminateResult> | null = null;
  let wake: () => void = () => undefined;
  let onStopped: () => void = () => undefined;
  const stopped = new Promise<void>((r) => (onStopped = r));
  const termOpts: TerminateOptions = { graceMs: opts.termGraceMs, killWaitMs: opts.killWaitMs };

  let finished = false;
  const requestStop = (end: OwnedEnd, detail: string) => {
    // After the run resolved its group is gone and the pid may belong to someone else: never signal it again.
    if (stopEnd || finished) return;
    stopEnd = end;
    stopDetail = detail;
    if (child?.pid) terminating = terminateOwnedGroup(child.pid, termOpts);
    onStopped();
    wake();
  };

  const done = (async (): Promise<OwnedRunResult> => {
    const finish = (r: Partial<OwnedRunResult> & Pick<OwnedRunResult, 'end'>): OwnedRunResult => ({
      code: null, signal: null, pid: null, startedAt: null, launchedAt, endedAt: Date.now(), pipeHeld: false, reap: { status: 'exited' }, reaped: true, error: '', ...r,
    });
    if (opts.signal?.aborted) return finish({ end: 'aborted', error: abortText(opts.signal) });

    let spawnError = null as Error | null;
    let closed = false as boolean;
    let exitInfo = null as { code: number | null; signal: NodeJS.Signals | null } | null;
    let exitedAt = 0;
    try {
      child = spawn(command, args as string[], {
        cwd: opts.cwd, env: opts.env, shell: opts.shell ?? false, detached: true,
        stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return finish({ end: 'spawn_failed', error: errText(err) });
    }
    const c = child;
    // Every listener is attached before the first await, so no exit or error can go unobserved.
    const settled = new Promise<void>((resolve) => {
      wake = resolve;
      c.on('error', (err) => {
        spawnError ??= err;
        if (!c.pid) resolve();
      });
      c.on('exit', (code, signal) => {
        exitInfo = { code, signal };
        exitedAt = Date.now();
        // A background process the child started can keep its pipes open after it exits.
        later(opts.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS, resolve);
      });
      c.on('close', () => {
        closed = true;
        resolve();
      });
    });
    const guard = (fn: ((d: Buffer) => void) | undefined) => (d: Buffer) => {
      if (!fn) return;
      try {
        fn(d);
      } catch (err) {
        requestStop('hook_failed', `output handler failed: ${errText(err)}`);
      }
    };
    c.stdout?.on('data', guard(opts.onStdout));
    c.stderr?.on('data', guard(opts.onStderr));
    if (c.stdin) {
      // EPIPE when the child exits without reading: its exit status decides the outcome, not the write.
      c.stdin.on('error', () => undefined);
      c.stdin.end(opts.stdin);
    }
    const pid = c.pid ?? null;
    if (pid === null) {
      await settled;
      return finish({ end: 'spawn_failed', error: spawnError ? errText(spawnError) : `could not start ${command}` });
    }

    const onAbort = () => requestStop('aborted', opts.signal ? abortText(opts.signal) : 'canceled');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.timeoutMs !== undefined) later(opts.timeoutMs, () => requestStop('timeout', `timed out after ${Math.round(opts.timeoutMs! / 1000)}s`));

    let startedAt: number | null = null;
    if (opts.onSpawn) {
      startedAt = await processStartTime(pid).catch(() => null);
      const hook = opts.onSpawn;
      const hookTimeout = opts.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
      let hookTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => hook({ pid, pgid: pid, startedAt, command, args })),
          new Promise<never>((_, reject) => {
            hookTimer = later(hookTimeout, () => reject(new Error(`did not finish within ${hookTimeout} ms`)));
          }),
          // Already stopping (abort, timeout): a slow registry must not delay the cleanup.
          stopped,
        ]);
      } catch (err) {
        requestStop('hook_failed', `process registration failed: ${errText(err)}`);
      } finally {
        if (hookTimer) {
          clearTimeout(hookTimer);
          timers.delete(hookTimer);
        }
      }
    }

    await settled;
    // A stop that is still escalating: wait for it, then give the pipes a moment to drain and close.
    if (terminating && !closed) {
      await terminating;
      if (!closed) await Promise.race([new Promise<void>((r) => c.once('close', () => r())), new Promise<void>((r) => later(500, r))]);
    }
    const ex = exitInfo;
    const pipeHeld = !closed && ex !== null && !stopEnd;
    const reap = terminating ? await terminating : await terminateOwnedGroup(pid, termOpts);
    // Whatever survived, never let our pipe handles keep this process alive or deliver late output.
    if (!closed) {
      c.stdout?.destroy();
      c.stderr?.destroy();
    }
    c.stdin?.destroy();
    finished = true;
    opts.signal?.removeEventListener('abort', onAbort);
    for (const t of timers) clearTimeout(t);
    timers.clear();
    // A leader that never reported exit is treated as still alive, whatever the group probe said.
    const reaped = reap.status === 'exited' || reap.status === 'terminated' ? ex !== null || !groupAlive(pid) : false;
    const end: OwnedEnd = stopEnd ?? (ex ? 'exit' : 'spawn_failed');
    return finish({
      end, code: ex?.code ?? null, signal: ex?.signal ?? null, pid, startedAt, endedAt: exitedAt || Date.now(), pipeHeld, reap, reaped,
      error: stopEnd ? stopDetail : spawnError ? errText(spawnError) : '',
    });
  })();

  return { stop: (reason) => requestStop('stopped', reason), done };
}

export function runOwnedProcess(command: string, args: readonly string[], opts: OwnedRunOptions): Promise<OwnedRunResult> {
  return startOwnedProcess(command, args, opts).done;
}

/** Durable utility intent. Tokens distinguish concurrent Git/config/copy children in one attempt. */
export interface UtilityProcessIntent {
  token: string;
  command: string;
  args: readonly string[];
  cwd: string;
}

export interface ProcessScopeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  termGraceMs?: number;
  killWaitMs?: number;
  exitGraceMs?: number;
  hookTimeoutMs?: number;
  /** Persist an intent before the OS can create a child. Failure prevents the spawn. */
  beforeSpawn?: (child: UtilityProcessIntent) => void | Promise<void>;
  /** Replace only this token's intent with its process identity. */
  onSpawn?: (token: string, child: OwnedProcessInfo) => void | Promise<void>;
  /** Called after cleanup, including failed spawns. Keep the intent when reaped is false. */
  onExit?: (token: string, result: OwnedRunResult) => void | Promise<void>;
}

interface UtilityScope {
  options: ProcessScopeOptions;
  stop: AbortController;
  pending: Set<Promise<RunResult>>;
  failure: Error | null;
  closed: boolean;
}
const utilityScope = new AsyncLocalStorage<UtilityScope>();

/** Direct coding/check/review children share the utility scope's failure stop. */
export function currentProcessScopeSignal(): AbortSignal | undefined {
  const scope = utilityScope.getStore();
  return scope ? scope.options.signal ? AbortSignal.any([scope.options.signal, scope.stop.signal]) : scope.stop.signal : undefined;
}

/** A utility failed its lifetime/registration contract; callers must not retry in its checkout. */
export class UtilityProcessError extends Error {
  readonly token: string;
  readonly result: OwnedRunResult;
  constructor(token: string, result: OwnedRunResult, detail?: string) {
    super(detail ?? `Owned utility ${token} ${result.end}: ${result.error || result.reap.reason || 'process group was not reaped'}`);
    this.name = 'UtilityProcessError';
    this.token = token;
    this.result = result;
  }
}

/**
 * Own all run() utilities in an attempt/integration operation without threading hooks through every Git helper.
 * A failure after launch or incomplete reap poisons this scope, even if a best-effort helper catches it.
 * A rejected intent never started a child and remains an ordinary command error.
 * Return only after all started utilities have been reaped and their exit records acknowledged.
 */
export async function withProcessScope<T>(options: ProcessScopeOptions, fn: () => Promise<T>): Promise<T> {
  const scope: UtilityScope = { options, stop: new AbortController(), pending: new Set(), failure: null, closed: false };
  return utilityScope.run(scope, async () => {
    let value: T | undefined;
    let thrown: unknown;
    let failed = false;
    try {
      value = await fn();
    } catch (err) {
      thrown = err;
      failed = true;
    } finally {
      scope.closed = true;
      // An unawaited utility may not outlive its caller, including when Promise.all rejects early.
      if (scope.pending.size) scope.stop.abort('utility scope ended');
      await Promise.allSettled([...scope.pending]);
    }
    if (scope.failure) throw scope.failure;
    if (failed) throw thrown;
    return value as T;
  });
}

function failScope(scope: UtilityScope, error: Error): never {
  scope.failure ??= error;
  scope.stop.abort(error.message);
  throw error;
}

async function utilityHook(scope: UtilityScope, fn: () => void | Promise<void>): Promise<void> {
  const timeout = scope.options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`utility hook did not finish within ${timeout} ms`)), timeout); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function scopedUtility(scope: UtilityScope, command: string, args: string[], opts: RunOptions): Promise<RunResult> {
  if (scope.closed || scope.failure) return Promise.reject(scope.failure ?? new Error('Utility scope is closed'));
  const token = randomUUID();
  const cwd = opts.cwd ?? process.cwd();
  const signals = [scope.stop.signal, scope.options.signal, opts.signal].filter((s): s is AbortSignal => s !== undefined);
  const signal = AbortSignal.any(signals);
  const launchedAt = Date.now();
  const promise = (async (): Promise<RunResult> => {
    let stdout = '';
    let stderr = '';
    const append = (stream: 'stdout' | 'stderr', d: Buffer) => {
      // execFile's existing 64 MiB output limit, enforced without retaining unbounded output.
      const part = d.toString();
      if ((stream === 'stdout' ? stdout.length : stderr.length) + part.length > 64 * 1024 * 1024) throw new Error('utility output exceeded 64 MiB');
      if (stream === 'stdout') stdout += part;
      else stderr += part;
    };
    let result: OwnedRunResult;
    let launchAttempted = false;
    try {
      if (signal.aborted) throw new Error(abortText(signal));
      if (scope.options.beforeSpawn) await utilityHook(scope, () => scope.options.beforeSpawn!({ token, command, args, cwd }));
      launchAttempted = true;
      result = await runOwnedProcess(command, args, {
        cwd, env: opts.env ?? cleanEnv(), stdin: opts.input, signal,
        timeoutMs: Math.min(opts.timeoutMs ?? 120_000, scope.options.timeoutMs ?? Infinity),
        termGraceMs: scope.options.termGraceMs, killWaitMs: scope.options.killWaitMs, exitGraceMs: scope.options.exitGraceMs,
        hookTimeoutMs: scope.options.hookTimeoutMs,
        onSpawn: scope.options.onSpawn ? (child) => scope.options.onSpawn!(token, child) : undefined,
        onStdout: (d) => append('stdout', d), onStderr: (d) => append('stderr', d),
      });
    } catch (err) {
      // Intent rejection (including a pending owner control or a temporary RPC outage)
      // cannot leave a child behind. In particular, do not stop a coding sibling here.
      // Still acknowledge the no-launch exit: the intent request may have reached its
      // server even if its response was lost. Remote journals retain that acknowledgment.
      if (!launchAttempted) {
        const noLaunch: OwnedRunResult = { end: signal.aborted ? 'aborted' : 'hook_failed', code: null, signal: null, pid: null, startedAt: null,
          launchedAt, endedAt: Date.now(), pipeHeld: false, reap: { status: 'exited' }, reaped: true, error: errText(err) };
        try { if (scope.options.onExit) await utilityHook(scope, () => scope.options.onExit!(token, noLaunch)); } catch { /* no child; durable journal retries the exit */ }
        throw err;
      }
      result = { end: signal.aborted ? 'aborted' : 'hook_failed', code: null, signal: null, pid: null, startedAt: null,
        launchedAt, endedAt: Date.now(), pipeHeld: false, reap: launchAttempted ? { status: 'unverified', reason: 'utility supervisor threw after launch was attempted' } : { status: 'exited' }, reaped: !launchAttempted, error: errText(err) };
    }
    try {
      if (scope.options.onExit) await utilityHook(scope, () => scope.options.onExit!(token, result));
    } catch (err) {
      return failScope(scope, new UtilityProcessError(token, result, `Utility exit registration failed: ${errText(err)}`));
    }
    if (!result.reaped || (result.end !== 'exit' && result.end !== 'spawn_failed')) return failScope(scope, new UtilityProcessError(token, result));
    if (result.end === 'spawn_failed') throw new Error(`Command not found or could not start: ${command}: ${result.error}`);
    return { code: result.code ?? 1, stdout, stderr };
  })();
  scope.pending.add(promise);
  // Observe rejection here as well as at the caller, so abandoned sibling promises never reject unhandled.
  void promise.then(() => scope.pending.delete(promise), () => scope.pending.delete(promise));
  return promise;
}

export interface ShellResult extends RunResult {
  timedOut: boolean;
  /** Ended by `signal` (code 130). */
  aborted: boolean;
  pid: number | null;
  /** False when something it started survived cleanup: do not run overlapping work in the same checkout. */
  reaped: boolean;
  reap: TerminateResult;
}

/**
 * Runs a user-configured shell command (verification, setup). Shell is intended: these come from the repo owner's
 * config. The command leads its own process group, and the group is cleaned up on every path, so background
 * processes a check starts (servers, watchers) do not outlive it, even when the check itself exits 0.
 */
export async function runShell(
  command: string,
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; onSpawn?: OwnedRunOptions['onSpawn']; termGraceMs?: number; exitGraceMs?: number },
): Promise<ShellResult> {
  let out = '';
  const cap = (d: Buffer) => {
    out += d.toString();
    if (out.length > 400_000) out = out.slice(-200_000);
  };
  const r = await runOwnedProcess(command, [], {
    cwd: opts.cwd, env: opts.env ?? cleanEnv({ CI: '1' }), shell: true, signal: opts.signal, timeoutMs: opts.timeoutMs,
    termGraceMs: opts.termGraceMs, exitGraceMs: opts.exitGraceMs, onSpawn: opts.onSpawn, onStdout: cap, onStderr: cap,
  });
  const base = { stderr: '', pid: r.pid, reaped: r.reaped, reap: r.reap };
  switch (r.end) {
    case 'timeout':
      return { ...base, code: 124, stdout: out, timedOut: true, aborted: false };
    case 'aborted':
      return { ...base, code: 130, stdout: out + (out ? '\n' : '') + `(canceled: ${r.error})`, timedOut: false, aborted: true };
    case 'spawn_failed':
      return { ...base, code: 127, stdout: out + r.error, timedOut: false, aborted: false };
    case 'hook_failed':
    case 'stopped':
      return { ...base, code: 1, stdout: out + (out ? '\n' : '') + r.error, timedOut: false, aborted: false };
    case 'exit':
      return { ...base, code: r.code ?? 1, stdout: out, timedOut: false, aborted: false };
  }
}

export function spawnDetached(cmd: string, args: string[], opts: SpawnOptions) {
  return spawn(cmd, args, { ...opts, detached: true });
}

/**
 * Signals the whole process group so agent sub-processes (test runners, dev servers) die with the agent.
 * Only a group is signaled: when no group with this id exists, a lone process with this pid is not one Yardmaster
 * started (every child it owns is a group leader), and is most likely an unrelated process that reused the pid.
 * Windows has no process groups, so there the pid itself is signaled.
 */
export function killGroup(pid: number | undefined | null, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (!signalable(pid)) return false;
  if (process.platform === 'win32') {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  return signalGroup(pid, signal);
}

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Process start time in epoch ms, used with the pid as an identity so a recycled pid is never
 * mistaken for our agent. Returns null when it cannot be determined.
 */
export async function processStartTime(pid: number): Promise<number | null> {
  if (process.platform === 'win32') return null;
  const r = await runUnscoped('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 5000 });
  const s = r.stdout.trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

export function which(cmd: string): string | null {
  if (cmd.includes('/')) return existsSync(cmd) ? cmd : null;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of exts) {
      const full = join(dir, cmd + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}
