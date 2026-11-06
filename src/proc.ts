import { spawn, execFile, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

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

export async function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<RunResult> {
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

/** Runs a user-configured shell command (verification). Shell is intended: these come from the repo owner's config. */
export function runShell(command: string, opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<RunResult & { timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: opts.cwd, env: opts.env ?? cleanEnv({ CI: '1' }), shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const cap = (d: Buffer) => {
      out += d.toString();
      if (out.length > 400_000) out = out.slice(-200_000);
    };
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, 'SIGKILL');
    }, opts.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout: out, stderr: '', timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: out + String(err), stderr: '', timedOut: false });
    });
  });
}

export function spawnDetached(cmd: string, args: string[], opts: SpawnOptions) {
  return spawn(cmd, args, { ...opts, detached: true });
}

/** Signals the whole process group so agent sub-processes (test runners, dev servers) die with the agent. */
export function killGroup(pid: number | undefined | null, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  // pid 0/1 or our own process would signal far more than one agent (kill(-1) hits every process we own).
  if (!pid || pid <= 1 || pid === process.pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
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
  const r = await run('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs: 5000 });
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
