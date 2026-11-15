import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as z from 'zod/v4';
import { runOwnedProcess, type OwnedRunOptions } from './proc.ts';
import { OwnedResourceSchema, type OwnedResource, type ResourceCleanup } from './leases.ts';

/**
 * Apple simulators through Xcode's own `xcrun simctl`. Only simulators Yardmaster created under a lease are ever
 * booted, installed into, shut down or deleted: every mutation goes through an OwnedSimulator, and cleanup checks
 * the recorded unique name before touching a UDID. Existing simulators (another session's included) are read only.
 */
export interface ToolContext { xcrun: string; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; onSpawn?: OwnedRunOptions['onSpawn'] }
export interface ExecResult { ok: boolean; clean: boolean; reaped: boolean; code: number | null; end: string; stdout: string; stderr: string; durationMs: number }

export function resolveTool(name: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = name.includes('/') ? [''] : (env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const file = resolve(cwd, dir, name);
    try { if (statSync(file).isFile()) { accessSync(file, constants.X_OK); return file; } } catch { /* next */ }
  }
  return null;
}

/**
 * Owned process with bounded stdout and stderr, kept apart so machine-read output (JSON, fingerprints) stays clean.
 * `clean` means it exited by itself and every descendant was reaped.
 */
export async function exec(ctx: Omit<ToolContext, 'xcrun'>, command: string, args: string[], opts: { timeoutMs: number; cancel?: boolean }): Promise<ExecResult> {
  const started = Date.now();
  const out = new StringDecoder('utf8'), err = new StringDecoder('utf8');
  let stdout = '', stderr = '';
  const r = await runOwnedProcess(command, args, { cwd: ctx.cwd, env: ctx.env, timeoutMs: opts.timeoutMs,
    signal: opts.cancel === false ? undefined : ctx.signal, onSpawn: ctx.onSpawn,
    onStdout: chunk => { stdout = (stdout + out.write(chunk)).slice(-256 * 1024); },
    onStderr: chunk => { stderr = (stderr + err.write(chunk)).slice(-64 * 1024); } });
  stdout += out.end(); stderr += err.end();
  const clean = r.end === 'exit' && r.reaped && r.code !== null;
  return { ok: clean && r.code === 0, clean, reaped: r.reaped, code: r.code, end: r.end, stdout, stderr, durationMs: Date.now() - started };
}

/** Both streams, for saved logs and failure details. */
export const transcript = (r: ExecResult) => r.stderr ? `${r.stdout}${r.stdout.endsWith('\n') || !r.stdout ? '' : '\n'}--- stderr ---\n${r.stderr}` : r.stdout;

/**
 * simctl is not run as an owned process group: booting starts the simulator's own processes, which inherit our
 * environment yet belong to the simulator. They end with `simctl shutdown`/`delete`, never with a signal from us.
 */
function simctl(ctx: ToolContext, args: string[], timeoutMs = 60_000, cancel = true): Promise<ExecResult> {
  const started = Date.now();
  return new Promise(resolve => {
    execFile(ctx.xcrun, ['simctl', ...args], { cwd: ctx.cwd, env: ctx.env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
      signal: cancel ? ctx.signal : undefined }, (error, stdout, stderr) => {
      const e = error as (Error & { code?: number | string; killed?: boolean }) | null;
      const end = !e ? 'exit' : e.name === 'AbortError' ? 'aborted' : e.killed ? 'timeout' : typeof e.code === 'number' ? 'exit' : 'spawn_failed';
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : null;
      resolve({ ok: !e, clean: end === 'exit', reaped: true, code, end, stdout: String(stdout ?? '').slice(-256 * 1024), stderr: String(stderr ?? '').slice(-64 * 1024), durationMs: Date.now() - started });
    });
  });
}

const ListSchema = z.object({
  devicetypes: z.array(z.object({ identifier: z.string(), name: z.string(), productFamily: z.string().optional(), modelIdentifier: z.string().optional() })).default([]),
  runtimes: z.array(z.object({ identifier: z.string(), name: z.string(), version: z.string(), isAvailable: z.boolean().default(true), platform: z.string().optional(),
    supportedDeviceTypes: z.array(z.object({ identifier: z.string(), name: z.string(), productFamily: z.string().optional() })).default([]) })).default([]),
  devices: z.record(z.string(), z.array(z.object({ udid: z.string(), name: z.string(), state: z.string(), isAvailable: z.boolean().optional() }))).default({}),
});
export type SimList = z.infer<typeof ListSchema>;

export async function listSimulators(ctx: ToolContext): Promise<SimList> {
  const r = await simctl(ctx, ['list', '-j'], 60_000, false);
  if (!r.ok) throw new Error(`xcrun simctl list failed (${r.end}${r.code !== null ? ` ${r.code}` : ''})`);
  return ListSchema.parse(JSON.parse(r.stdout));
}

/** Numeric, part by part; missing parts count as zero (18.6 is newer than 18.5.1). */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(n => Number(n) || 0), y = b.split('.').map(n => Number(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
export interface Target { runtime: { identifier: string; name: string; version: string }; deviceType: { identifier: string; name: string; modelIdentifier: string | null } }

/** Explicit choice, or the newest available iOS runtime and its first iPhone. Never reuses an existing device. */
export function chooseTarget(list: SimList, want: { runtime?: string; deviceType?: string }): Target | { error: string } {
  const ios = list.runtimes.filter(r => r.isAvailable && (r.platform ? r.platform === 'iOS' : r.name.startsWith('iOS')));
  const runtime = want.runtime ? ios.find(r => [r.identifier, r.name, r.version].includes(want.runtime!))
    : [...ios].sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!runtime) return { error: want.runtime ? `no available iOS runtime matches "${want.runtime}"` : 'no iOS simulator runtime is installed (Xcode > Settings > Components)' };
  const supported = runtime.supportedDeviceTypes.length ? runtime.supportedDeviceTypes : list.devicetypes;
  const type = want.deviceType ? supported.find(d => d.identifier === want.deviceType || d.name === want.deviceType)
    : supported.find(d => (d.productFamily ?? '').toLowerCase() === 'iphone' || d.name.startsWith('iPhone'));
  if (!type) return { error: want.deviceType ? `${runtime.name} does not support device type "${want.deviceType}"` : `${runtime.name} supports no iPhone device type` };
  const model = list.devicetypes.find(d => d.identifier === type.identifier)?.modelIdentifier ?? null;
  return { runtime: { identifier: runtime.identifier, name: runtime.name, version: runtime.version }, deviceType: { identifier: type.identifier, name: type.name, modelIdentifier: model } };
}

/** A simulator created by this lease. Its methods are the only path to mutating simctl commands. */
export class OwnedSimulator {
  readonly ctx: ToolContext;
  readonly name: string;
  readonly udid: string;
  private constructor(ctx: ToolContext, name: string, udid: string) { this.ctx = ctx; this.name = name; this.udid = udid; }

  /** `own` must durably record the name before creation so a crash right after creation can still be cleaned up. */
  static async create(ctx: ToolContext, name: string, target: Target, own: (resource: OwnedResource) => void): Promise<OwnedSimulator> {
    own(OwnedResourceSchema.parse({ kind: 'simulator', name, udid: null }));
    const r = await simctl(ctx, ['create', name, target.deviceType.identifier, target.runtime.identifier], 120_000);
    const udid = r.stdout.trim().split('\n').at(-1)?.trim() ?? '';
    if (!r.ok || !/^[0-9A-F-]{36}$/i.test(udid)) throw new Error(`could not create simulator ${name} (${r.end}${r.code !== null ? ` ${r.code}` : ''})`);
    own({ kind: 'simulator', name, udid });
    return new OwnedSimulator(ctx, name, udid);
  }

  async boot(timeoutMs: number): Promise<ExecResult> {
    const boot = await simctl(this.ctx, ['boot', this.udid], 120_000);
    if (!boot.ok) return boot;
    return simctl(this.ctx, ['bootstatus', this.udid, '-b'], timeoutMs);
  }
  install(app: string): Promise<ExecResult> { return simctl(this.ctx, ['install', this.udid, app], 300_000); }
  async launch(bundleId: string, stdoutFile: string, stderrFile: string): Promise<ExecResult & { pid: number | null }> {
    const r = await simctl(this.ctx, ['launch', '--terminate-running-process', `--stdout=${stdoutFile}`, `--stderr=${stderrFile}`, this.udid, bundleId], 120_000);
    const pid = Number(r.stdout.match(new RegExp(`${bundleId.replace(/[.]/g, '\\.')}:\\s*(\\d+)`))?.[1] ?? NaN);
    return { ...r, pid: Number.isSafeInteger(pid) ? pid : null };
  }
  screenshot(file: string): Promise<ExecResult> { return simctl(this.ctx, ['io', this.udid, 'screenshot', file], 60_000); }
  terminate(bundleId: string): Promise<ExecResult> { return simctl(this.ctx, ['terminate', this.udid, bundleId], 60_000, false); }
}

/**
 * Shut down and delete simulators this lease recorded, after confirming each still carries the recorded unique
 * name. Runs without the cancellation signal: cleanup must finish after a cancel. Success means confirmed absent.
 */
export async function cleanupOwnedSimulators(ctx: ToolContext, owned: OwnedResource[]): Promise<{ ok: boolean; detail: string }> {
  const quiet = { ...ctx, signal: undefined };
  const problems: string[] = [];
  let list: SimList;
  try { list = await listSimulators(quiet); } catch (error) { return { ok: false, detail: (error as Error).message }; }
  const devices = Object.values(list.devices).flat();
  for (const resource of owned.filter(r => r.kind === 'simulator')) {
    const found = devices.find(d => resource.udid ? d.udid === resource.udid : d.name === resource.name);
    if (!found) continue;
    if (found.name !== resource.name || !resource.name.startsWith('ym-')) { problems.push(`${found.udid} is not named ${resource.name}; left untouched`); continue; }
    if (found.state !== 'Shutdown') await simctl(quiet, ['shutdown', found.udid], 120_000, false);
    const deleted = await simctl(quiet, ['delete', found.udid], 120_000, false);
    if (!deleted.ok) problems.push(`could not delete ${found.udid}: ${deleted.stderr.trim().slice(0, 200)}`);
  }
  try {
    const after = Object.values((await listSimulators(quiet)).devices).flat();
    for (const resource of owned) if (after.some(d => resource.udid ? d.udid === resource.udid : d.name === resource.name)) problems.push(`${resource.name} still exists`);
  } catch (error) { problems.push((error as Error).message); }
  return problems.length ? { ok: false, detail: [...new Set(problems)].join('; ') } : { ok: true, detail: `removed ${owned.length} owned simulator(s)` };
}

/** Cleanup for reapers (hub, CLI) that did not create the simulators but find their recorded leases. */
export function hostCleanup(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ResourceCleanup {
  return async owned => {
    const xcrun = resolveTool('xcrun', cwd, env);
    if (!xcrun) return { ok: false, detail: 'xcrun is not available to clean up recorded simulators' };
    return cleanupOwnedSimulators({ xcrun, cwd, env }, owned);
  };
}
