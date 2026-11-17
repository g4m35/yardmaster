import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { exec, type ExecResult, type ToolContext } from './simctl.ts';

/**
 * Physical Apple devices through Xcode's `xcrun devicectl`. Machine-read results always come from its
 * `--json-output` file (versioned and stable across releases), never from its human-readable stdout.
 * Nothing here pairs, unlocks, changes settings on, or removes anything from a device; callers decide which
 * app may be installed or uninstalled.
 */

const Str = z.string().optional();
/** Xcode 26+ puts everything under `properties`; older releases (and deprecated fields) use the three dictionaries. */
const DeviceSchema = z.object({
  identifier: z.string(),
  properties: z.object({
    hardware: z.object({ udid: Str, marketingName: Str, productType: Str, platform: Str, reality: Str, serialNumber: Str, ecid: z.number().optional() }).partial().optional(),
    software: z.object({ osVersionNumber: z.object({ stringValue: Str }).optional(), osBuildVersions: z.object({ buildVersion: z.object({ name: Str }).optional() }).optional() }).optional(),
    state: z.object({ name: Str, bootState: Str, developerModeStatus: z.union([z.string(), z.record(z.string(), z.unknown())]).optional() }).optional(),
    connection: z.object({ pairingState: Str, transportType: Str, state: Str }).optional(),
  }).optional(),
  hardwareProperties: z.object({ udid: Str, marketingName: Str, productType: Str, platform: Str, reality: Str, serialNumber: Str, ecid: z.number().optional() }).optional(),
  deviceProperties: z.object({ name: Str, osVersionNumber: Str, osBuildUpdate: Str, bootState: Str, developerModeStatus: Str }).optional(),
  connectionProperties: z.object({ pairingState: Str, transportType: Str, tunnelState: Str }).optional(),
});
const Envelope = <T extends z.ZodType>(result: T) => z.object({ info: z.object({ outcome: z.string() }), result });
const ListSchema = Envelope(z.object({ devices: z.array(DeviceSchema) }));
const LockSchema = Envelope(z.object({ passcodeRequired: z.boolean(), unlockedSinceBoot: z.boolean().optional() }));
const AppsSchema = Envelope(z.object({ apps: z.array(z.object({ bundleIdentifier: z.string(), name: Str, version: Str, bundleVersion: Str, url: Str })) }));
const ProcessesSchema = Envelope(z.object({ runningProcesses: z.array(z.object({ executable: Str, processIdentifier: z.number().int() })) }));
const FilesSchema = Envelope(z.object({ files: z.array(z.object({ name: z.string(), relativePath: Str,
  metadata: z.object({ lastModDate: Str, size: z.number().optional() }).optional(), resources: z.object({ isDirectory: z.boolean().optional() }).optional() })) }));
const InstallSchema = Envelope(z.object({ installedApplications: z.array(z.object({ bundleID: Str, installationURL: Str })).default([]) }));

export interface PhysicalDevice {
  /** CoreDevice identifier; like the UDID, serial and ECID it identifies hardware and never enters shareable evidence. */
  identifier: string; udid: string; name: string; model: string; modelIdentifier: string | null; platform: string;
  osVersion: string | null; osBuild: string | null; pairing: string | null; developerMode: 'enabled' | 'disabled' | 'unknown';
  bootState: string | null; transport: string | null; serial: string | null; ecid: string | null;
  /** `unavailable` when CoreDevice cannot reach it now (unplugged, asleep off-network); `disconnected` is normal before use. */
  connection: string | null;
}
export interface InstalledApp { bundleId: string; name: string | null; version: string | null; build: string | null; url: string | null }

/** Stable, non-reversible device key for evidence and leases: the same phone gets the same key on every machine. */
export const deviceKey = (udid: string) => `d-${createHash('sha256').update(`yardmaster-device:${udid.toUpperCase()}`).digest('hex').slice(0, 20)}`;

function normalize(d: z.infer<typeof DeviceSchema>): PhysicalDevice | null {
  const hw = { ...d.hardwareProperties, ...d.properties?.hardware };
  if (hw.reality !== 'physical' || !hw.udid) return null;
  const mode = d.properties?.state?.developerModeStatus ?? d.deviceProperties?.developerModeStatus;
  const developerMode = typeof mode === 'string' ? (mode === 'enabled' ? 'enabled' : mode === 'disabled' ? 'disabled' : 'unknown')
    : mode && 'enabled' in mode ? 'enabled' : mode && 'disabled' in mode ? 'disabled' : 'unknown';
  return { identifier: d.identifier, udid: hw.udid, name: d.properties?.state?.name ?? d.deviceProperties?.name ?? hw.marketingName ?? 'device',
    model: hw.marketingName ?? hw.productType ?? 'Apple device', modelIdentifier: hw.productType ?? null, platform: hw.platform ?? 'unknown',
    osVersion: d.properties?.software?.osVersionNumber?.stringValue ?? d.deviceProperties?.osVersionNumber ?? null,
    osBuild: d.properties?.software?.osBuildVersions?.buildVersion?.name ?? d.deviceProperties?.osBuildUpdate ?? null,
    pairing: d.properties?.connection?.pairingState ?? d.connectionProperties?.pairingState ?? null, developerMode,
    bootState: d.properties?.state?.bootState ?? d.deviceProperties?.bootState ?? null,
    transport: d.properties?.connection?.transportType ?? d.connectionProperties?.transportType ?? null,
    serial: hw.serialNumber ?? null, ecid: hw.ecid !== undefined ? String(hw.ecid) : null,
    connection: d.properties?.connection?.state ?? d.connectionProperties?.tunnelState ?? null };
}

/**
 * Every value that identifies the hardware or its owner, for redaction from saved text. The user-given name often
 * holds a person's name; it is left alone only when it is just the model ("iPhone 17"), which says nothing more.
 */
export const deviceIdentifiers = (d: PhysicalDevice) => [d.udid, d.identifier, d.serial, d.ecid, d.name !== d.model ? d.name : null]
  .filter((v): v is string => !!v && v.length >= 6);

export type DeviceChoice = { device: PhysicalDevice } | { unavailable: string };
/**
 * The configured device (UDID or name), or the only paired iOS device. Anything that would make a run meaningless
 * (unpaired, untrusted, Developer Mode off, not booted) is a reason, never a guess at another device.
 */
export function chooseDevice(devices: PhysicalDevice[], want: { udid?: string; name?: string }): DeviceChoice {
  const ios = devices.filter(d => d.platform === 'iOS' || d.platform === 'iPadOS');
  const wanted = want.udid ? ios.filter(d => d.udid.toUpperCase() === want.udid!.toUpperCase())
    : want.name ? ios.filter(d => d.name === want.name) : ios.filter(d => d.pairing === 'paired');
  const label = want.udid ? `device ${deviceKey(want.udid)}` : want.name ? `device "${want.name}"` : 'a paired iPhone or iPad';
  if (!wanted.length) return { unavailable: `${label} is not known to this Mac. Connect it with a cable (or on the same network after pairing), unlock it and tap Trust` };
  if (wanted.length > 1) return { unavailable: `${wanted.length} devices match ${want.name ? `the name "${want.name}"` : 'and none is configured'}; set options.device.udid` };
  const device = wanted[0]!;
  if (device.pairing !== 'paired') return { unavailable: `${device.model} is not paired with this Mac (${device.pairing ?? 'unknown'}): unlock it, connect it and tap Trust` };
  if (device.connection === 'unavailable') return { unavailable: `${device.model} is paired but not reachable now: connect it with a cable (or join the same network), unlock it and keep it awake` };
  if (device.developerMode !== 'enabled') return { unavailable: `${device.model} does not have Developer Mode enabled (Settings > Privacy & Security > Developer Mode)` };
  if (device.bootState && device.bootState !== 'booted') return { unavailable: `${device.model} is not booted (${device.bootState})` };
  return { device };
}

/** Runs one devicectl command and parses its JSON result file. */
export class Devicectl {
  readonly tool: ToolContext;
  private readonly dir: string;
  constructor(tool: ToolContext, scratch: string) {
    this.tool = tool;
    // devicectl's JSON includes serial numbers and ECIDs: keep it in private scratch, never in the evidence folder.
    this.dir = join(scratch, `devicectl-${randomBytes(4).toString('hex')}`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  dispose(): void { rmSync(this.dir, { recursive: true, force: true }); }

  /** `cancel: false` for cleanup, which must finish after a cancel. */
  async run<T extends z.ZodType>(args: string[], schema: T | null, opts: { timeoutMs?: number; cancel?: boolean; tool?: ToolContext } = {}): Promise<{ r: ExecResult; json: z.infer<T> | null; error: string | null }> {
    const file = join(this.dir, `${randomBytes(6).toString('hex')}.json`);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const tool = opts.tool ?? this.tool;
    const r = await exec(tool, tool.xcrun, ['devicectl', ...args, '--timeout', String(Math.max(5, Math.floor(timeoutMs / 1000) - 5)), '--json-output', file],
      { timeoutMs, cancel: opts.cancel });
    let raw: unknown = null;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { raw = null; } finally { rmSync(file, { force: true }); }
    if (!r.ok || !schema) return { r, json: null, error: r.ok ? null : failure(r, raw) };
    const parsed = schema.safeParse(raw);
    return parsed.success ? { r, json: parsed.data, error: null } : { r, json: null, error: 'devicectl returned JSON this version of Yardmaster does not understand' };
  }

  async list(): Promise<PhysicalDevice[] | { error: string }> {
    const { json, error } = await this.run(['list', 'devices'], ListSchema, { cancel: false });
    return json ? json.result.devices.map(normalize).filter((d): d is PhysicalDevice => !!d) : { error: error ?? 'devicectl list devices failed' };
  }
  async locked(device: string): Promise<boolean | { error: string }> {
    const { json, error } = await this.run(['device', 'info', 'lockState', '--device', device], LockSchema);
    return json ? json.result.passcodeRequired : { error: error ?? 'lock state unavailable' };
  }
  async app(device: string, bundleId: string): Promise<InstalledApp | null | { error: string }> {
    const { json, error } = await this.run(['device', 'info', 'apps', '--device', device, '--bundle-id', bundleId], AppsSchema);
    if (!json) return { error: error ?? 'installed apps unavailable' };
    const app = json.result.apps.find(a => a.bundleIdentifier === bundleId);
    return app ? { bundleId, name: app.name ?? null, version: app.version ?? null, build: app.bundleVersion ?? null, url: app.url ?? null } : null;
  }
  async processes(device: string, cancel = true): Promise<{ pid: number; executable: string }[] | { error: string }> {
    const { json, error } = await this.run(['device', 'info', 'processes', '--device', device], ProcessesSchema, { cancel });
    return json ? json.result.runningProcesses.map(p => ({ pid: p.processIdentifier, executable: p.executable ?? '' })) : { error: error ?? 'process list unavailable' };
  }
  async install(device: string, path: string): Promise<{ r: ExecResult; error: string | null }> {
    const { r, json, error } = await this.run(['device', 'install', 'app', '--device', device, path], InstallSchema, { timeoutMs: 600_000 });
    return { r, error: error ?? (json && !json.result.installedApplications.length ? 'devicectl reported no installed application' : null) };
  }
  async uninstall(device: string, bundleId: string): Promise<{ r: ExecResult; error: string | null }> {
    const { r, error } = await this.run(['device', 'uninstall', 'app', '--device', device, bundleId], null, { timeoutMs: 120_000, cancel: false });
    return { r, error };
  }
  async terminate(device: string, pid: number): Promise<{ r: ExecResult; error: string | null }> {
    const { r, error } = await this.run(['device', 'process', 'terminate', '--device', device, '--pid', String(pid)], null, { cancel: false });
    return { r, error };
  }
  async screenshot(device: string, file: string): Promise<{ r: ExecResult; error: string | null }> {
    const { r, error } = await this.run(['device', 'capture', 'screenshot', '--device', device, '--destination', file], null);
    return { r, error };
  }
  /** Top-level crash reports (`systemCrashLogs` domain): name and modification time. */
  async crashLogs(device: string): Promise<{ name: string; modified: number }[] | { error: string }> {
    const { json, error } = await this.run(['device', 'info', 'files', '--device', device, '--domain-type', 'systemCrashLogs'], FilesSchema, { cancel: false });
    if (!json) return { error: error ?? 'crash logs unavailable' };
    return json.result.files.filter(f => !f.resources?.isDirectory && !(f.relativePath ?? f.name).includes('/'))
      .map(f => ({ name: f.relativePath ?? f.name, modified: Date.parse(f.metadata?.lastModDate ?? '') || 0 }));
  }
  async copyCrashLog(device: string, name: string, destination: string): Promise<{ r: ExecResult; error: string | null }> {
    const { r, error } = await this.run(['device', 'copy', 'from', '--device', device, '--domain-type', 'systemCrashLogs', '--source', name, '--destination', destination], null, { cancel: false });
    return { r, error };
  }
}

const ErrorSchema = z.object({ error: z.object({ userInfo: z.record(z.string(), z.unknown()).optional() }).optional() });
function failure(r: ExecResult, raw: unknown): string {
  const info = ErrorSchema.safeParse(raw);
  const description = info.success ? info.data.error?.userInfo?.NSLocalizedDescription : undefined;
  const message = typeof description === 'object' && description && 'string' in description ? String((description as { string: unknown }).string)
    : typeof description === 'string' ? description : (r.stderr || r.stdout).trim().split('\n').filter(Boolean).at(-1) ?? '';
  return `devicectl ${r.end === 'exit' ? 'failed' : r.end}${r.code !== null ? ` (exit ${r.code})` : ''}${message ? `: ${message.slice(0, 300)}` : ''}`;
}
