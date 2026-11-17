import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { basename, join, resolve } from 'node:path';
import * as z from 'zod/v4';
import { loadConfig } from './config.ts';
import { fileSha256, isTextFile, redactText, sanitizeEvidenceFile, scrubFile, type DeviceEvidence } from './device-evidence.ts';
import { Command, fill, InputSchema, snapshot, tail, TestSchema, walkFiles, type DeviceRun, type DeviceRunContext } from './device-provider.ts';
import { chooseDevice, deviceIdentifiers, deviceKey, Devicectl, type InstalledApp, type PhysicalDevice } from './devicectl.ts';
import { acquireLease, type LeaseHandle, type LeaseOutcome } from './leases.ts';
import { memoryHold, sampleMemory } from './machine-pressure.ts';
import { machineId, yardHome } from './paths.ts';
import { cleanupOwnedSimulators, exec, resolveTool, transcript, type ExecResult, type ToolContext } from './simctl.ts';

/** Names of the built-in phases; a user test may not reuse them and hide among them. */
const PHASES = ['build', 'device', 'install', 'launch', 'crash-reports', 'uninstall'];

/** Per-project recipe for the built-in physical Apple device provider (docs/DEVICES.md). */
export const AppleDeviceOptionsSchema = z.object({
  bundleId: z.string().regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/),
  requires: z.enum(['simulator', 'physical']).default('physical'),
  /** Which paired device; with neither, the only paired iPhone or iPad. */
  device: z.object({
    udid: z.string().regex(/^[0-9A-Fa-f-]{20,40}$/).optional(),
    name: z.string().min(1).max(200).optional(),
  }).strict().refine(d => !(d.udid && d.name), 'set device.udid or device.name, not both').prefault({}),
  /**
   * A device-signed build to install. Without it the run tests the copy already installed on the device and installs
   * nothing; that evidence cannot accept a commit, since it is not a build of it.
   */
  build: z.object({
    command: Command.optional(),
    /** The signed .app (or .ipa) for iphoneos that your build produces. */
    app: z.string().min(1),
    timeoutMinutes: z.number().min(1).max(240).default(30),
  }).strict().optional(),
  install: z.object({
    /** Install over a copy of this bundle ID that the run did not install (the app's data stays). Off: such a run stops. */
    replaceExisting: z.boolean().default(false),
    /** Remove the app afterwards, only when this run installed it fresh. */
    uninstallAfter: z.boolean().default(false),
  }).strict().prefault({}),
  launch: z.boolean().default(true),
  /** How long the launched app gets to draw before the launch screenshot. */
  settleSeconds: z.number().min(0).max(60).default(4),
  tests: z.array(TestSchema.refine(t => !PHASES.includes(t.name), `${PHASES.join(', ')} are reserved check names`)
    .refine(t => t.runner !== 'maestro', 'Maestro does not support physical iOS devices; use XCTest, agent-device or a command')).max(10).default([]),
  requiredEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
}).strict();
export type AppleDeviceOptions = z.infer<typeof AppleDeviceOptionsSchema>;

type Check = DeviceEvidence['checks'][number];
type Files = DeviceEvidence['files'];
interface Recorder {
  checks: Check[]; saveLog(name: string, text: string): string; keep(file: string, kind: Files[number]['kind']): void;
  track(r: ExecResult): ExecResult; identifiers: string[];
}

/** Queue → build slot → physical-device lease → discover, install (optional), launch, screenshot, tests → evidence. */
export async function runAppleDevice(options: AppleDeviceOptions, ctx: DeviceRunContext): Promise<DeviceRun> {
  const startedAt = new Date().toISOString();
  const sha = ctx.context.sha ?? null;
  const checks: Check[] = [];
  const files: Files = [];
  const config = ctx.devices ?? loadConfig(ctx.cwd).devices;
  const machine = ctx.devices ?? loadConfig().devices;
  const sample = ctx.sampleMemory ?? sampleMemory;
  const admit = async () => memoryHold(await sample(), config);
  let reaped = true;
  let requirement = options.requires;
  let artifact: DeviceEvidence['artifact'] = null;
  let device: DeviceEvidence['device'] = null;
  let deviceApp: DeviceEvidence['deviceApp'] = null;
  let leaseRecord: DeviceEvidence['lease'] = null;
  let failedBuild = false;
  let problem: string | null = null;
  let unreaped: { pid: number; startedAt: number | null }[] = [];
  const track = (r: ExecResult) => { if (!r.reaped) { reaped = false; if (r.process) unreaped.push(r.process); } return r; };
  const secrets = options.requiredEnv.map(name => ctx.env[name]).filter((v): v is string => !!v).sort((a, b) => b.length - a.length);
  // Hardware identifiers (UDID, serial, ECID) leave saved text; unlike credentials they never cause a file to be dropped.
  const identifiers: string[] = [];
  const redact = (text: string) => redactText(redactText(text, secrets), identifiers);
  const omitted: DeviceEvidence['omitted'] = [];
  const keep = (file: string, kind: Files[number]['kind']) => {
    if (sanitizeEvidenceFile(file, secrets) === 'omitted') { omitted.push({ path: file, reason: 'omitted: contains a declared credential' }); return; }
    if (identifiers.length && isTextFile(file)) scrubFile(file, identifiers);
    files.push({ path: file, sha256: fileSha256(file), kind });
  };
  const saveLog = (name: string, text: string) => {
    const file = join(ctx.evidenceDir, name);
    writeFileSync(file, redact(text), { mode: 0o600 });
    files.push({ path: file, sha256: fileSha256(file), kind: 'log' });
    return file;
  };
  const xcrun = resolveTool('xcrun', ctx.cwd, ctx.env);
  const tool: ToolContext = { xcrun: xcrun ?? 'xcrun', cwd: ctx.cwd, env: ctx.env, signal: ctx.signal, onSpawn: ctx.onSpawn };
  const parsedInput = InputSchema.safeParse(ctx.input ?? {});
  if (!parsedInput.success) problem = 'Device check input accepts only {"requires": "simulator" | "physical"}.';
  else requirement = parsedInput.data.requires ?? requirement;
  if (!xcrun && !problem) problem = 'xcrun is not available; physical Apple devices need macOS with Xcode installed.';
  const xcodeVersion = xcrun && !problem ? await exec(tool, xcrun, ['xcodebuild', '-version'], { timeoutMs: 30_000 }).catch(() => null) : null;
  const environment = { machineId: machineId(), os: `${platform()} ${release()}`, arch: arch(),
    xcode: xcodeVersion?.ok ? xcodeVersion.stdout.trim().split('\n').join(' ').slice(0, 200) : null };
  if (xcrun && !problem) {
    const found = await exec(tool, xcrun, ['--find', 'devicectl'], { timeoutMs: 30_000 });
    if (!found.ok) problem = 'xcrun devicectl is not available. Physical devices need Xcode 15 or later (xcode-select -p must point at Xcode, not the Command Line Tools).';
  }

  const lease = (pool: 'build' | 'physical'): Promise<LeaseOutcome> => acquireLease({ pool, capacity: Math.min(config.limits[pool], machine.limits[pool]),
    holder: ctx.context.taskId ? `task:${ctx.context.taskId}` : ctx.context.projectId ? `project:${ctx.context.projectId}` : 'cli',
    projectId: ctx.context.projectId ?? null, taskId: ctx.context.taskId ?? null, requestId: ctx.requestId,
    ttlMs: config.leaseMinutes * 60_000, waitMs: config.waitMinutes * 60_000, pollMs: ctx.pollMs, signal: ctx.signal, admit,
    cleanup: owned => cleanupOwnedSimulators(tool, owned) });

  // ---- artifact (optional): built or existing, hashed and installed from this run's own copy ----
  const scratch = join(yardHome(), 'tmp', `device-${ctx.requestId}`);
  let installPath: string | null = null;
  if (!problem && options.build) {
    const appPath = resolve(ctx.cwd, options.build.app);
    let built: { path: string; sha256: string } | null = null;
    if (options.build.command) {
      const slot = await lease('build');
      if (!slot.lease) problem = `No build slot: ${slot.reason}.`;
      else {
        try {
          const exe = resolveTool(options.build.command[0]!, ctx.cwd, ctx.env);
          const r = exe ? track(await exec({ ...tool, signal: AbortSignal.any([slot.lease.lost, ...(ctx.signal ? [ctx.signal] : [])]) }, exe, options.build.command.slice(1), { timeoutMs: options.build.timeoutMinutes * 60_000, reinspectDelayMs: ctx.reinspectDelayMs })) : null;
          const log = saveLog('build.log', r ? transcript(r) : `${options.build.command[0]} is not installed`);
          const status = !r ? 'unavailable' : r.clean ? (r.code === 0 ? 'passed' : 'failed') : 'unknown';
          checks.push({ name: 'build', runner: 'command', status, durationMs: r?.durationMs ?? null, detail: status === 'passed' ? 'Build command passed.' : `Build ${status}${r?.code ? ` (exit ${r.code})` : ''}${r?.cleanup ? `; process cleanup ${r.cleanup}` : ''}: ${tail(r ? transcript(r) : '', 600)}`, log });
          if (status === 'failed') failedBuild = true;
          else if (status !== 'passed') problem = 'The build did not complete cleanly.';
          else built = existsSync(appPath) ? snapshot(appPath, scratch) : null;
        } finally {
          if (unreaped.length) slot.lease.retain(unreaped, 'build process not confirmed stopped');
          else slot.lease.release();
          unreaped = [];
        }
      }
    }
    if (!problem && !failedBuild) {
      const taken = built ?? (!options.build.command && existsSync(appPath) ? snapshot(appPath, scratch) : null);
      if (!taken) problem = `No app at ${options.build.app}. Set build.app to the signed .app (or .ipa) for iphoneos your build produces.`;
      else {
        installPath = taken.path;
        artifact = { path: appPath, sha256: taken.sha256, bundleId: options.bundleId, source: options.build.command ? 'built' : 'existing', fingerprint: null, builtFromCommit: options.build.command ? sha : null };
      }
    }
  }

  // ---- device: one machine-wide physical lease for the whole run ----
  if (!problem && !failedBuild) {
    const slot = await lease('physical');
    if (!slot.lease) {
      problem = `No physical-device slot: ${slot.reason}.`;
      leaseRecord = { id: 'none', pool: 'physical', queuedAt: slot.queuedAt, acquiredAt: null, releasedAt: null, waitedMs: slot.waitedMs, cleanup: 'not-acquired' };
    } else {
      const held = slot.lease;
      leaseRecord = { id: held.id, pool: 'physical', queuedAt: held.queuedAt, acquiredAt: held.acquiredAt, releasedAt: null, waitedMs: slot.waitedMs, cleanup: 'released' };
      const ctl = new Devicectl({ ...tool, signal: AbortSignal.any([held.lost, ...(ctx.signal ? [ctx.signal] : [])]) }, scratch);
      try {
        const outcome = await onDevice(options, ctx, ctl, held, installPath, artifact, sha, { checks, saveLog, keep, track, identifiers });
        device = outcome.device; deviceApp = outcome.app; problem = outcome.problem;
      } finally { ctl.dispose(); }
      const freed = finishLease(held, unreaped);
      leaseRecord = { ...leaseRecord, releasedAt: Date.now(), cleanup: freed.ok ? 'released' : 'cleanup_failed' };
      if (!freed.ok && !problem) problem = `${freed.detail}. Inspect it and run "ym devices reap" or "ym devices release".`;
    }
  }

  rmSync(scratch, { recursive: true, force: true });
  const canceled = !!ctx.signal?.aborted;
  // Crash reports that could not be read do not decide the result; a crash also fails launch or a test.
  const ran = checks.filter(c => c.name !== 'build' && c.name !== 'device' && !(c.name === 'crash-reports' && c.status === 'skipped'));
  const unavailable = checks.some(c => c.status === 'unavailable' && (c.name === 'device' || c.name === 'install'));
  let physical: DeviceEvidence['status']['physical'];
  if (failedBuild || unavailable || !device) physical = 'untested';
  else if (ran.some(c => c.status === 'failed')) physical = 'failed';
  // Installing and reading crash reports exercise nothing: a pass needs the app launched or a test run.
  else if (problem || canceled || !ran.some(c => c.name === 'launch' || options.tests.some(t => t.name === c.name)) || ran.some(c => c.status !== 'passed')) physical = 'unknown';
  else physical = 'passed';
  const overall: DeviceEvidence['status']['overall'] = failedBuild || physical === 'failed' ? 'failed'
    : canceled || !reaped || problem || physical !== 'passed' ? 'unknown' : 'passed';
  const what = device ? `${device.model} (${device.runtime})` : 'the device';
  const summary = canceled ? `Device verification was canceled. ${leaseRecord?.cleanup === 'cleanup_failed' ? 'Its slot stays held until its processes are confirmed stopped' : 'Its slot was released'}. Inspect the receipt before retrying.`
    : failedBuild ? 'The app build failed; nothing ran on the device.'
    : !reaped ? 'A device-test process survived cleanup. Inspect owned processes before retrying.'
    : problem ? redact(problem)
    : physical === 'failed' ? `Checks failed on ${what}: ${ran.filter(c => c.status === 'failed').map(c => c.name).join(', ')}.`
    : physical !== 'passed' ? `Checks on ${what} did not complete: ${ran.filter(c => c.status !== 'passed').map(c => `${c.name} ${c.status}`).join(', ') || 'none configured'}.`
    : `Physical device passed on ${what}.${!artifact && deviceApp ? ` It tested the copy of ${deviceApp.bundleId} already installed (${deviceApp.version ?? '?'} build ${deviceApp.build ?? '?'}), not a build of this commit.` : ''}`;
  for (const check of checks) check.detail = redact(check.detail);
  const evidence: DeviceEvidence = { kind: 'yardmaster.device-evidence', version: 1, requestId: ctx.requestId,
    projectId: ctx.context.projectId ?? null, taskId: ctx.context.taskId ?? null, commit: sha, requirement,
    status: { code: ctx.context.codeChecks === 'passed' ? 'passed' : 'not-run', simulator: 'not-run', physical, overall },
    artifact, environment, device, deviceApp, checks, files: files.slice(0, 100), omitted: omitted.slice(0, 100), lease: leaseRecord,
    startedAt, completedAt: new Date().toISOString(), summary };
  writeFileSync(join(ctx.evidenceDir, 'device-evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  return { dispatched: !!xcrun && parsedInput.success, execution: { end: canceled ? 'aborted' : 'exit', code: canceled ? null : 0, reaped },
    result: { status: overall, summary, artifacts: [join(ctx.evidenceDir, 'device-evidence.json'), ...files.map(f => f.path)].slice(0, 100), costUsd: null, data: { evidence } } };
}

/** Nothing was created on the device under the lease, so freeing it only waits for commands confirmed stopped. */
function finishLease(lease: LeaseHandle, unreaped: { pid: number; startedAt: number | null }[]): { ok: boolean; detail: string } {
  if (!lease.holds()) return { ok: false, detail: 'The physical-device lease expired and was reclaimed' };
  if (unreaped.length) {
    lease.retain(unreaped, 'device-test process not confirmed stopped');
    return { ok: false, detail: `${unreaped.length} process(es) not confirmed stopped; the device slot stays held until they are` };
  }
  lease.release();
  return { ok: true, detail: 'released' };
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(done => {
  const timer = setTimeout(finish, ms);
  function finish() { clearTimeout(timer); signal?.removeEventListener('abort', finish); done(); }
  signal?.addEventListener('abort', finish, { once: true });
});

async function onDevice(options: AppleDeviceOptions, ctx: DeviceRunContext, ctl: Devicectl, lease: LeaseHandle, installPath: string | null,
  artifact: DeviceEvidence['artifact'], sha: string | null, rec: Recorder) {
  const result = { device: null as DeviceEvidence['device'], app: null as DeviceEvidence['deviceApp'], problem: null as string | null };
  const tool = ctl.tool;
  const unavailable = (name: string, detail: string) => { rec.checks.push({ name, runner: 'devicectl', status: 'unavailable', durationMs: null, detail, log: null }); return result; };
  const failed = (name: string, r: ExecResult, error: string | null) => `${name} ${r.end}${r.code !== null ? ` (exit ${r.code})` : ''}${error ? `: ${error}` : `: ${tail(transcript(r), 600)}`}`;

  // ---- discovery: every reason the device cannot be used is reported, never worked around ----
  const discovered = Date.now();
  const listed = await ctl.list();
  if ('error' in listed) return unavailable('device', `Cannot list devices: ${listed.error}.`);
  const choice = chooseDevice(listed, options.device);
  if ('unavailable' in choice) return unavailable('device', `${choice.unavailable}.`);
  const phone: PhysicalDevice = choice.device;
  rec.identifiers.push(...deviceIdentifiers(phone));
  rec.identifiers.sort((a, b) => b.length - a.length);
  const key = deviceKey(phone.udid);
  const locked = await ctl.locked(phone.udid);
  if (typeof locked !== 'boolean') return unavailable('device', `${phone.model} did not answer (${locked.error}). Unlock it, keep it connected, and check that it trusts this Mac.`);
  if (locked) return unavailable('device', `${phone.model} is locked. Unlock it (and keep it awake) for the run.`);
  const other = lease.claimDevice(key);
  if (other) return unavailable('device', `${phone.model} is in use by another Yardmaster run (${other}).`);
  const runtime = `${phone.platform} ${phone.osVersion ?? 'unknown'}`;
  result.device = { kind: 'physical', name: phone.model, model: phone.model, modelIdentifier: phone.modelIdentifier,
    runtime, runtimeIdentifier: `${runtime}${phone.osBuild ? ` (${phone.osBuild})` : ''}`, udid: key, createdByYardmaster: false };
  rec.checks.push({ name: 'device', runner: 'devicectl', status: 'passed', durationMs: Date.now() - discovered,
    detail: `${phone.model} (${phone.modelIdentifier ?? 'unknown model'}) on ${runtime}: paired, unlocked, Developer Mode on${phone.transport ? `, ${phone.transport} connection` : ''}.`, log: null });

  // ---- app: install only a build this run was given; never replace a copy it did not install unless configured ----
  const before = await ctl.app(phone.udid, options.bundleId);
  if (before && 'error' in before) return unavailable('install', `Cannot read installed apps: ${before.error}.`);
  let installedByRun = false;
  let app: InstalledApp | null = before;
  if (installPath) {
    if (before && !options.install.replaceExisting) {
      return unavailable('install', `${options.bundleId} is already installed on ${phone.model} (${before.version ?? '?'} build ${before.build ?? '?'}) and this run did not install it. Remove it yourself, set install.replaceExisting, or drop build to test the installed copy.`);
    }
    const { r, error } = await ctl.install(phone.udid, installPath);
    rec.track(r);
    const ok = r.ok && !error;
    rec.checks.push({ name: 'install', runner: 'devicectl', status: ok ? 'passed' : r.clean ? 'failed' : 'unknown', durationMs: r.durationMs,
      detail: ok ? `Installed ${basename(artifact!.path)} (sha256 ${artifact!.sha256.slice(0, 12)})${before ? ' over the existing copy (install.replaceExisting)' : ''}.` : failed('install', r, error), log: null });
    if (!ok) return result;
    installedByRun = !before;
    const after = await ctl.app(phone.udid, options.bundleId);
    if (!after || 'error' in after) { result.problem = `${options.bundleId} is not listed on the device after installing it.`; return result; }
    app = after;
  } else if (!before) {
    return unavailable('install', `${options.bundleId} is not installed on ${phone.model}. Install it, or set build.app to a device-signed build for this run to install.`);
  }
  result.app = { bundleId: options.bundleId, name: app!.name, version: app!.version, build: app!.build, installedByRun };
  // The app's process is recognized by its executable inside the installed bundle.
  const bundleUrl = (app!.url ?? '').replace(/\/$/, '');

  try {
    const crashesBefore = await ctl.crashLogs(phone.udid);
    let pid: number | null = null;
    let attachedRun: { done: boolean; result: Promise<ExecResult> } | null = null;
    const stopConsole = new AbortController();
    const running = async (cancel = true): Promise<{ pid: number; executable: string }[]> => {
      const list = await ctl.processes(phone.udid, cancel);
      return 'error' in list || !bundleUrl ? [] : list.filter(p => p.executable.startsWith(`${bundleUrl}/`));
    };
    const shot = async (name: string) => {
      const file = join(ctx.evidenceDir, `${name}.png`);
      const { r } = await ctl.screenshot(phone.udid, file);
      rec.track(r);
      if (r.ok && existsSync(file)) rec.keep(file, 'screenshot');
    };

    // ---- launch: attached to the console, so the app's own stdout and stderr become a log ----
    if (options.launch) {
      const started = Date.now();
      const attached = exec({ ...tool, signal: AbortSignal.any([stopConsole.signal, ...(tool.signal ? [tool.signal] : [])]) }, tool.xcrun,
        ['devicectl', 'device', 'process', 'launch', '--device', phone.udid, '--terminate-existing', '--console', options.bundleId], { timeoutMs: 6 * 3600_000 });
      attachedRun = { done: false, result: attached };
      void attached.then(() => { attachedRun!.done = true; });
      for (let i = 0; i < 60 && pid === null && !attachedRun.done && !tool.signal?.aborted; i++) {
        await sleep(500, tool.signal);
        pid = (await running())[0]?.pid ?? null;
      }
      const detail = pid !== null ? `Launched ${options.bundleId} (pid ${pid}); it is running.`
        : attachedRun.done ? `${options.bundleId} exited during launch: ${tail(transcript(await attached), 600)}`
        : tool.signal?.aborted ? 'Canceled during launch.' : `${options.bundleId} was not seen running within 30 seconds of launch.`;
      rec.checks.push({ name: 'launch', runner: 'devicectl', status: pid !== null ? 'passed' : tool.signal?.aborted ? 'unknown' : 'failed', durationMs: Date.now() - started, detail, log: null });
      if (pid !== null) {
        await sleep(options.settleSeconds * 1000, tool.signal);
        if (!tool.signal?.aborted) await shot('launch');
      }
    }

    // ---- user smoke commands: any tool, given the device and bundle; they may drive the UI ----
    const values = { udid: phone.udid, app: installPath ?? '', bundleId: options.bundleId, sha: sha ?? '' };
    for (const test of options.tests) {
      if (tool.signal?.aborted) { rec.checks.push({ name: test.name, runner: test.runner, status: 'unknown', durationMs: null, detail: 'Canceled before this test started.', log: null }); continue; }
      const dir = join(ctx.evidenceDir, 'tests', test.name);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const argv = fill(test.command ?? ['maestro', '--device', '{udid}', 'test', '--format', 'junit', '--output', '{artifacts}/report.xml', test.flow!], { ...values, artifacts: dir });
      const exe = resolveTool(argv[0]!, ctx.cwd, tool.env);
      const probe = exe && (test.runner === 'maestro' || test.runner === 'agent-device') ? rec.track(await exec(tool, exe, ['--version'], { timeoutMs: 60_000 })) : null;
      if (!exe || (probe && !probe.ok)) {
        rec.checks.push({ name: test.name, runner: test.runner, status: 'unavailable', durationMs: null,
          detail: !exe ? `${argv[0]} is not installed on this machine; no result is claimed.` : `${argv[0]} --version failed; the tool is present but not working.`, log: null });
        continue;
      }
      const env = { ...tool.env, YARDMASTER_DEVICE_UDID: phone.udid, YARDMASTER_DEVICE_KIND: 'physical', YARDMASTER_APP_PATH: installPath ?? '',
        YARDMASTER_BUNDLE_ID: options.bundleId, YARDMASTER_ARTIFACT_DIR: dir, YARDMASTER_VERIFY_SHA: sha ?? '' };
      const r = rec.track(await exec({ ...tool, env }, exe, argv.slice(1), { timeoutMs: test.timeoutMinutes * 60_000, reinspectDelayMs: ctx.reinspectDelayMs }));
      const log = rec.saveLog(`test-${test.name}.log`, transcript(r));
      const status = r.clean ? (r.code === 0 ? 'passed' : 'failed') : 'unknown';
      rec.checks.push({ name: test.name, runner: test.runner, status, durationMs: r.durationMs, detail: status === 'passed' ? 'Passed.' : `${status}${r.code !== null ? ` (exit ${r.code})` : ` (${r.end})`}${r.cleanup ? `; process cleanup ${r.cleanup}` : ''}: ${tail(transcript(r), 600)}`, log });
    }
    if (!tool.signal?.aborted && (options.launch || options.tests.length)) await shot('final');

    // ---- stop what this run launched; the console ends with the app ----
    if (attachedRun) {
      // Runs after a cancel too: what this run launched is stopped either way.
      for (const proc of await running(false)) await ctl.terminate(phone.udid, proc.pid);
      const ended = await Promise.race([attachedRun.result.then(() => true), sleep(20_000).then(() => false)]);
      if (!ended) stopConsole.abort('the app did not stop after terminate');
      const r = rec.track(await attachedRun.result);
      rec.saveLog('app-console.log', transcript(r));
    }

    // ---- crash reports this app wrote during the run ----
    const crashesAfter = await ctl.crashLogs(phone.udid);
    if ('error' in crashesBefore || 'error' in crashesAfter) {
      rec.checks.push({ name: 'crash-reports', runner: 'devicectl', status: 'skipped', durationMs: null, detail: `Crash reports could not be read: ${'error' in crashesAfter ? crashesAfter.error : (crashesBefore as { error: string }).error}.`, log: null });
    } else {
      const exe = bundleUrl.split('/').at(-1)?.replace(/\.app$/, '') ?? '';
      const known = new Set(crashesBefore.map(c => c.name));
      const fresh = crashesAfter.filter(c => !known.has(c.name) && exe && (c.name.startsWith(`${exe}-`) || c.name.startsWith(`${exe}.`))).slice(0, 10);
      const dir = join(ctx.evidenceDir, 'crashes');
      for (const crash of fresh) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = join(dir, basename(crash.name));
        const { r } = await ctl.copyCrashLog(phone.udid, crash.name, file);
        if (r.ok && existsSync(file)) rec.keep(file, 'log');
      }
      rec.checks.push({ name: 'crash-reports', runner: 'devicectl', status: fresh.length ? 'failed' : 'passed', durationMs: null,
        detail: fresh.length ? `${options.bundleId} wrote ${fresh.length} crash report(s) during the run: ${fresh.map(c => c.name).join(', ')}.` : `No new crash reports from ${exe || options.bundleId}.`, log: null });
    }
    for (const file of walkFiles(join(ctx.evidenceDir, 'tests'))) rec.keep(file, /\.(png|jpe?g|heic)$/i.test(file) ? 'screenshot' : 'report');
  } catch (error) {
    result.problem = `Device run failed: ${(error as Error).message}.`;
  } finally {
    if (installedByRun && options.install.uninstallAfter) {
      const { r, error } = await ctl.uninstall(phone.udid, options.bundleId);
      rec.checks.push({ name: 'uninstall', runner: 'devicectl', status: r.ok && !error ? 'passed' : 'unknown', durationMs: r.durationMs,
        detail: r.ok && !error ? `Removed ${options.bundleId}, which this run installed.` : failed('uninstall', r, error), log: null });
    }
  }
  return result;
}
