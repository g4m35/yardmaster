import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import * as z from 'zod/v4';
import { loadConfig, type Config } from './config.ts';
import { artifactSha256, fileSha256, type DeviceEvidence } from './device-evidence.ts';
import { mainRepoRoot, projectIdFor } from './git.ts';
import { acquireLease, type LeaseHandle, type LeaseOutcome, type OwnedResource } from './leases.ts';
import { memoryHold, sampleMemory, type MemorySampler } from './machine-pressure.ts';
import { machineId, yardHome } from './paths.ts';
import type { OwnedRunOptions } from './proc.ts';
import type { ProviderResult } from './provider-contract.ts';
import type { ServiceContext } from './service-receipts.ts';
import { chooseTarget, cleanupOwnedSimulators, exec, listSimulators, OwnedSimulator, resolveTool, type ExecResult, type ToolContext } from './simctl.ts';

const Command = z.array(z.string().min(1)).min(1);
const TestSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
  /** Labels the tool for availability checks and evidence. Commands are argument arrays, never shell strings. */
  runner: z.enum(['maestro', 'xcodebuild', 'agent-device', 'command']),
  command: Command.optional(),
  /** Maestro flow file; with no command, runs `maestro --device {udid} test` on it with a JUnit report. */
  flow: z.string().min(1).optional(),
  timeoutMinutes: z.number().min(1).max(240).default(15),
}).strict().refine(t => t.command || (t.runner === 'maestro' && t.flow), 'a test needs a command (or, for maestro, a flow)');

/** Per-project verification recipe for the built-in Apple simulator provider (docs/DEVICES.md). */
export const AppleSimulatorOptionsSchema = z.object({
  bundleId: z.string().regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/),
  /** A physical requirement is never satisfied by a simulator: it stays "untested" until a device lab reports it. */
  requires: z.enum(['simulator', 'physical']).default('simulator'),
  build: z.object({
    /** Your existing build (xcodebuild, expo run, a script). Without it the app must already exist at `app`. */
    command: Command.optional(),
    app: z.string().min(1),
    /** Reuse a previous build only when your own tool reports the same compatibility key. */
    reuse: z.enum(['never', 'fingerprint']).default('never'),
    fingerprint: Command.optional(),
    timeoutMinutes: z.number().min(1).max(240).default(30),
  }).strict().refine(b => b.reuse === 'never' || !!b.fingerprint, 'build.reuse "fingerprint" needs build.fingerprint'),
  simulator: z.object({
    runtime: z.string().min(1).optional(),
    deviceType: z.string().min(1).optional(),
    bootTimeoutMinutes: z.number().min(1).max(30).default(5),
  }).strict().prefault({}),
  /** Launch the installed app and screenshot it: the minimal smoke check. */
  launch: z.boolean().default(true),
  tests: z.array(TestSchema).max(10).default([]),
  requiredEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
}).strict();
export type AppleSimulatorOptions = z.infer<typeof AppleSimulatorOptionsSchema>;
const InputSchema = z.object({ requires: z.enum(['simulator', 'physical']).optional() }).strict();

type Check = DeviceEvidence['checks'][number];
type Files = DeviceEvidence['files'];
export interface DeviceRunContext {
  cwd: string; env: NodeJS.ProcessEnv; evidenceDir: string; input: unknown; requestId: string;
  context: ServiceContext; signal?: AbortSignal; onSpawn?: OwnedRunOptions['onSpawn'];
  /** Injectable for tests; production reads the executing machine's config and memory. */
  devices?: Config['devices']; sampleMemory?: MemorySampler; pollMs?: number;
}
export interface DeviceRun {
  dispatched: boolean;
  execution: { end: string; code: number | null; reaped: boolean };
  result: Omit<ProviderResult, 'data'> & { data: { evidence: DeviceEvidence } };
}

export function parseFingerprint(stdout: string): string | null {
  const text = stdout.trim();
  try {
    const json = JSON.parse(text) as unknown;
    const hash = json && typeof json === 'object' ? (json as { hash?: unknown }).hash : null;
    if (typeof hash === 'string' && /^[A-Za-z0-9._:-]{8,200}$/.test(hash)) return hash;
  } catch { /* plain text */ }
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  return lines.length === 1 && /^[A-Za-z0-9._:-]{8,200}$/.test(lines[0]!) ? lines[0]! : null;
}

const fill = (args: string[], values: Record<string, string>) => args.map(arg => arg.replace(/\{(udid|app|bundleId|artifacts|sha)\}/g, (_, key: string) => values[key] ?? ''));
const tail = (text: string, max = 1500) => text.length > max ? text.slice(-max) : text;

/** Queue → build slot → simulator lease → create/boot/install → launch, screenshot, tests → evidence → cleanup. */
export async function runAppleSimulator(options: AppleSimulatorOptions, ctx: DeviceRunContext): Promise<DeviceRun> {
  const startedAt = new Date().toISOString();
  const sha = ctx.context.sha ?? null;
  const checks: Check[] = [];
  const files: Files = [];
  const config = ctx.devices ?? loadConfig(ctx.cwd).devices;
  const sample = ctx.sampleMemory ?? sampleMemory;
  const admit = async () => memoryHold(await sample(), config);
  let reaped = true;
  let requirement = options.requires;
  let artifact: DeviceEvidence['artifact'] = null;
  let device: DeviceEvidence['device'] = null;
  let leaseRecord: DeviceEvidence['lease'] = null;
  let simulator: DeviceEvidence['status']['simulator'] = 'not-run';
  let failedBuild = false;
  let problem: string | null = null;
  const track = (r: ExecResult) => { if (!r.reaped) reaped = false; return r; };
  const saveLog = (name: string, text: string) => {
    const file = join(ctx.evidenceDir, name);
    writeFileSync(file, text, { mode: 0o600 });
    files.push({ path: file, sha256: fileSha256(file), kind: 'log' });
    return file;
  };
  const xcrun = resolveTool('xcrun', ctx.cwd, ctx.env);
  const tool: ToolContext = { xcrun: xcrun ?? 'xcrun', cwd: ctx.cwd, env: ctx.env, signal: ctx.signal, onSpawn: ctx.onSpawn };
  const parsedInput = InputSchema.safeParse(ctx.input ?? {});
  if (!parsedInput.success) problem = 'Device check input accepts only {"requires": "simulator" | "physical"}.';
  else requirement = parsedInput.data.requires ?? requirement;
  if (!xcrun && !problem) problem = 'xcrun is not available; Apple simulators need macOS with Xcode installed.';
  const xcodeVersion = xcrun && !problem ? await exec(tool, xcrun, ['xcodebuild', '-version'], { timeoutMs: 30_000 }).catch(() => null) : null;
  const environment = { machineId: machineId(), os: `${platform()} ${release()}`, arch: arch(),
    xcode: xcodeVersion?.ok ? xcodeVersion.stdout.trim().split('\n').join(' ').slice(0, 200) : null };

  const lease = (pool: 'build' | 'simulator'): Promise<LeaseOutcome> => acquireLease({ pool, capacity: config.limits[pool],
    holder: ctx.context.taskId ? `task:${ctx.context.taskId}` : ctx.context.projectId ? `project:${ctx.context.projectId}` : 'cli',
    projectId: ctx.context.projectId ?? null, taskId: ctx.context.taskId ?? null, requestId: ctx.requestId,
    ttlMs: config.leaseMinutes * 60_000, waitMs: config.waitMinutes * 60_000, pollMs: ctx.pollMs, signal: ctx.signal, admit,
    cleanup: owned => cleanupOwnedSimulators(tool, owned) });

  // ---- artifact: reuse only on an exact compatibility key; anything uncertain builds normally ----
  if (!problem) {
    const appPath = resolve(ctx.cwd, options.build.app);
    let fingerprint: string | null = null;
    if (options.build.fingerprint) {
      const exe = resolveTool(options.build.fingerprint[0]!, ctx.cwd, ctx.env);
      const r = exe ? track(await exec(tool, exe, options.build.fingerprint.slice(1), { timeoutMs: 300_000 })) : null;
      fingerprint = r?.ok ? parseFingerprint(r.stdout) : null;
    }
    const project = ctx.context.projectId ?? await mainRepoRoot(ctx.cwd).then(root => root ? projectIdFor(root) : null).catch(() => null);
    const cacheDir = options.build.reuse === 'fingerprint' && fingerprint && project ? join(yardHome(), 'device-builds',
      createHash('sha256').update(JSON.stringify({ project, bundleId: options.bundleId, app: options.build.app, command: options.build.command ?? null, fingerprint })).digest('hex').slice(0, 32)) : null;
    const cached = cacheDir ? readCache(cacheDir) : null;
    if (cached) {
      artifact = { path: cached.path, sha256: cached.sha256, bundleId: options.bundleId, source: 'reused', fingerprint, builtFromCommit: cached.commit };
      checks.push({ name: 'build', runner: 'reuse', status: 'skipped', durationMs: 0, detail: `Reused the build of ${cached.commit?.slice(0, 12) ?? 'an earlier commit'}: fingerprint ${fingerprint} matched and the stored artifact hash verified.`, log: null });
    } else if (options.build.command) {
      const slot = await lease('build');
      if (!slot.lease) problem = `No build slot: ${slot.reason}.`;
      else {
        try {
          const exe = resolveTool(options.build.command[0]!, ctx.cwd, ctx.env);
          const r = exe ? track(await exec(tool, exe, options.build.command.slice(1), { timeoutMs: options.build.timeoutMinutes * 60_000 })) : null;
          const log = saveLog('build.log', r?.stdout ?? `${options.build.command[0]} is not installed`);
          const status = !r ? 'unavailable' : r.clean ? (r.code === 0 ? 'passed' : 'failed') : 'unknown';
          checks.push({ name: 'build', runner: 'command', status, durationMs: r?.durationMs ?? null, detail: status === 'passed' ? 'Build command passed.' : `Build ${status}${r?.code ? ` (exit ${r.code})` : ''}: ${tail(r?.stdout ?? '', 600)}`, log });
          if (status === 'failed') failedBuild = true;
          else if (status !== 'passed') problem = 'The build did not complete cleanly.';
        } finally { slot.lease.release(); }
      }
    }
    if (!problem && !failedBuild && !artifact) {
      if (!existsSync(appPath)) problem = `No app at ${options.build.app}. Set build.app to the .app your build produces.`;
      else {
        const sha256 = artifactSha256(appPath);
        artifact = { path: appPath, sha256, bundleId: options.bundleId, source: options.build.command ? 'built' : 'existing', fingerprint, builtFromCommit: options.build.command ? sha : null };
        if (cacheDir && options.build.command) storeCache(cacheDir, appPath, sha256, sha);
      }
    }
  }

  // ---- simulator: one machine-wide lease; only the simulator this lease creates is touched ----
  if (!problem && !failedBuild && artifact) {
    const slot = await lease('simulator');
    if (!slot.lease) {
      problem = `No simulator slot: ${slot.reason}.`;
      leaseRecord = { id: 'none', pool: 'simulator', queuedAt: slot.queuedAt, acquiredAt: null, releasedAt: null, waitedMs: slot.waitedMs, cleanup: 'not-acquired' };
    } else {
      const held = slot.lease;
      leaseRecord = { id: held.id, pool: 'simulator', queuedAt: held.queuedAt, acquiredAt: held.acquiredAt, releasedAt: null, waitedMs: slot.waitedMs, cleanup: 'released' };
      const outcome = await onSimulator(options, ctx, { ...tool, signal: AbortSignal.any([held.lost, ...(ctx.signal ? [ctx.signal] : [])]) }, held, artifact, sha, checks, files, saveLog, track);
      device = outcome.device;
      problem = outcome.problem;
      const cleanup = await finishLease(held, tool, outcome.owned);
      leaseRecord = { ...leaseRecord, releasedAt: Date.now(), cleanup: cleanup.ok ? 'released' : 'cleanup_failed' };
      if (!cleanup.ok) problem = `Simulator cleanup was not confirmed (${cleanup.detail}). Its slot stays held; inspect it and run "ym devices reap" or "ym devices release".`;
    }
  }

  const canceled = !!ctx.signal?.aborted;
  const ran = checks.filter(c => c.name !== 'build');
  if (failedBuild) simulator = 'not-run';
  else if (ran.some(c => c.status === 'failed')) simulator = 'failed';
  else if (problem || canceled || !ran.length || ran.some(c => c.status !== 'passed')) simulator = device ? 'unknown' : 'not-run';
  else simulator = 'passed';
  // This adapter never drives hardware, so a physical requirement can only end unknown here.
  const physical = 'untested' as const;
  const overall: DeviceEvidence['status']['overall'] = failedBuild || simulator === 'failed' ? 'failed'
    : canceled || !reaped || problem || requirement === 'physical' || simulator !== 'passed' ? 'unknown' : 'passed';
  const summary = canceled ? 'Device verification was canceled. Owned simulators were cleaned up; inspect the receipt before retrying.'
    : failedBuild ? 'The app build failed; no device test ran.'
    : !reaped ? 'A device-test process survived cleanup. Inspect owned processes before retrying.'
    : problem ? problem
    : simulator === 'failed' ? `Simulator checks failed: ${ran.filter(c => c.status === 'failed').map(c => c.name).join(', ')}.`
    : simulator !== 'passed' ? `Simulator checks did not complete: ${ran.filter(c => c.status !== 'passed').map(c => `${c.name} ${c.status}`).join(', ') || 'none configured'}.`
    : requirement === 'physical' ? 'Simulator passed; physical device untested. A simulator pass does not satisfy this physical-device requirement.'
    : 'Simulator passed. Physical device untested.';
  const evidence: DeviceEvidence = { kind: 'yardmaster.device-evidence', version: 1, requestId: ctx.requestId,
    projectId: ctx.context.projectId ?? null, taskId: ctx.context.taskId ?? null, commit: sha, requirement,
    status: { code: ctx.context.codeChecks === 'passed' ? 'passed' : 'not-run', simulator, physical, overall },
    artifact, environment, device, checks, files: files.slice(0, 100), lease: leaseRecord, startedAt, completedAt: new Date().toISOString(), summary };
  writeFileSync(join(ctx.evidenceDir, 'device-evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  return { dispatched: !!xcrun && parsedInput.success, execution: { end: canceled ? 'aborted' : 'exit', code: canceled ? null : 0, reaped },
    result: { status: overall, summary, artifacts: [join(ctx.evidenceDir, 'device-evidence.json'), ...files.map(f => f.path)].slice(0, 100), costUsd: null, data: { evidence } } };
}

async function onSimulator(options: AppleSimulatorOptions, ctx: DeviceRunContext, tool: ToolContext, lease: LeaseHandle, artifact: NonNullable<DeviceEvidence['artifact']>,
  sha: string | null, checks: Check[], files: Files, saveLog: (name: string, text: string) => string, track: (r: ExecResult) => ExecResult) {
  const owned: OwnedResource[] = [];
  const result = { device: null as DeviceEvidence['device'], problem: null as string | null, owned };
  const step = (name: string, runner: string, r: ExecResult, detail: string) => {
    track(r);
    const status = r.ok ? 'passed' : r.clean && name !== 'boot' && name !== 'install' ? 'failed' : 'unknown';
    checks.push({ name, runner, status, durationMs: r.durationMs, detail: r.ok ? detail : `${name} ${r.end}${r.code !== null ? ` (exit ${r.code})` : ''}: ${tail(r.stdout, 600)}`, log: null });
    return r.ok;
  };
  const screenshot = async (sim: OwnedSimulator, name: string) => {
    const file = join(ctx.evidenceDir, `${name}.png`);
    const r = track(await sim.screenshot(file));
    if (r.ok && existsSync(file)) files.push({ path: file, sha256: fileSha256(file), kind: 'screenshot' });
  };
  try {
    const target = chooseTarget(await listSimulators(tool), options.simulator);
    if ('error' in target) { result.problem = `Cannot choose a simulator: ${target.error}.`; return result; }
    const name = `ym-${lease.id.slice(2, 10)}-${randomBytes(3).toString('hex')}`;
    const sim = await OwnedSimulator.create(tool, name, target, resource => {
      lease.own(resource);
      const at = owned.findIndex(o => o.name === resource.name);
      if (at >= 0) owned[at] = resource; else owned.push(resource);
    });
    result.device = { kind: 'simulator', name, model: target.deviceType.name, modelIdentifier: target.deviceType.modelIdentifier,
      runtime: target.runtime.name, runtimeIdentifier: target.runtime.identifier, udid: sim.udid, createdByYardmaster: true };
    if (!step('boot', 'simctl', await sim.boot(options.simulator.bootTimeoutMinutes * 60_000), `Booted ${target.deviceType.name} on ${target.runtime.name}.`)) return result;
    if (!step('install', 'simctl', await sim.install(artifact.path), `Installed ${basename(artifact.path)} (sha256 ${artifact.sha256.slice(0, 12)}).`)) return result;
    if (options.launch) {
      const out = join(ctx.evidenceDir, 'app-stdout.log'), err = join(ctx.evidenceDir, 'app-stderr.log');
      const launched = await sim.launch(options.bundleId, out, err);
      step('launch', 'simctl', { ...launched, ok: launched.ok && launched.pid !== null }, `Launched ${options.bundleId} (pid ${launched.pid}).`);
      // Give the app a moment to draw its first frame before the screenshot.
      await new Promise(resolve => setTimeout(resolve, 1500));
      await screenshot(sim, 'launch');
      for (const file of [out, err]) if (existsSync(file)) files.push({ path: file, sha256: fileSha256(file), kind: 'log' });
    }
    const values = { udid: sim.udid, app: artifact.path, bundleId: options.bundleId, sha: sha ?? '' };
    for (const test of options.tests) {
      if (tool.signal?.aborted) { checks.push({ name: test.name, runner: test.runner, status: 'unknown', durationMs: null, detail: 'Canceled before this test started.', log: null }); continue; }
      const dir = join(ctx.evidenceDir, 'tests', test.name);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const argv = fill(test.command ?? ['maestro', '--device', '{udid}', 'test', '--format', 'junit', '--output', '{artifacts}/report.xml', test.flow!], { ...values, artifacts: dir });
      const exe = resolveTool(argv[0]!, ctx.cwd, tool.env);
      const probe = exe && (test.runner === 'maestro' || test.runner === 'agent-device') ? track(await exec(tool, exe, ['--version'], { timeoutMs: 60_000 })) : null;
      if (!exe || (probe && !probe.ok)) {
        checks.push({ name: test.name, runner: test.runner, status: 'unavailable', durationMs: null,
          detail: !exe ? `${argv[0]} is not installed on this machine; no result is claimed.` : `${argv[0]} --version failed; the tool is present but not working (for Maestro, check its Java runtime).`, log: null });
        continue;
      }
      const env = { ...tool.env, YARDMASTER_DEVICE_UDID: sim.udid, YARDMASTER_DEVICE_KIND: 'simulator', YARDMASTER_APP_PATH: artifact.path,
        YARDMASTER_BUNDLE_ID: options.bundleId, YARDMASTER_ARTIFACT_DIR: dir, YARDMASTER_VERIFY_SHA: sha ?? '' };
      const r = track(await exec({ ...tool, env }, exe, argv.slice(1), { timeoutMs: test.timeoutMinutes * 60_000 }));
      const log = saveLog(`test-${test.name}.log`, r.stdout);
      const status = r.clean ? (r.code === 0 ? 'passed' : 'failed') : 'unknown';
      checks.push({ name: test.name, runner: test.runner, status, durationMs: r.durationMs, detail: status === 'passed' ? 'Passed.' : `${status}${r.code !== null ? ` (exit ${r.code})` : ` (${r.end})`}: ${tail(r.stdout, 600)}`, log });
    }
    for (const file of walkFiles(join(ctx.evidenceDir, 'tests'))) files.push({ path: file, sha256: fileSha256(file), kind: file.endsWith('.png') ? 'screenshot' : 'report' });
    if (!tool.signal?.aborted) await screenshot(sim, 'final');
  } catch (error) {
    result.problem = `Simulator setup failed: ${(error as Error).message}.`;
  }
  return result;
}

/** Clean only what this lease recorded, then release. If the lease was reclaimed, the reaper owns cleanup. */
async function finishLease(lease: LeaseHandle, tool: ToolContext, owned: OwnedResource[]): Promise<{ ok: boolean; detail: string }> {
  if (!lease.holds()) return { ok: false, detail: 'the lease expired and was reclaimed; its reaper cleans its simulators' };
  const cleanup = owned.length ? await cleanupOwnedSimulators(tool, owned) : { ok: true, detail: 'nothing created' };
  if (cleanup.ok) lease.release(); else lease.cleanupFailed(cleanup.detail);
  return cleanup;
}

function walkFiles(dir: string, depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walkFiles(join(dir, entry.name), depth + 1)
    : entry.isFile() ? [join(dir, entry.name)] : []).slice(0, 80);
}

const CacheSchema = z.object({ path: z.string(), sha256: z.string(), commit: z.string().nullable() });
function readCache(dir: string): z.infer<typeof CacheSchema> | null {
  try {
    const entry = CacheSchema.parse(JSON.parse(readFileSync(join(dir, 'artifact.json'), 'utf8')));
    // A cached artifact is reused only if it still hashes to what was stored.
    return existsSync(entry.path) && relative(dir, entry.path).split('/')[0] !== '..' && artifactSha256(entry.path) === entry.sha256 ? entry : null;
  } catch { return null; }
}
function storeCache(dir: string, app: string, sha256: string, commit: string | null): void {
  const staging = `${dir}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const copy = join(staging, basename(app));
    cpSync(app, copy, { recursive: true, verbatimSymlinks: true });
    if (artifactSha256(copy) !== sha256) return;
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
    writeFileSync(join(dir, 'artifact.json'), JSON.stringify({ path: join(dir, basename(app)), sha256, commit }), { mode: 0o600 });
  } catch { /* A failed cache write only means the next run builds again. */ }
  finally { rmSync(staging, { recursive: true, force: true }); }
}
