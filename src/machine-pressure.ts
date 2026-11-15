import { readFileSync } from 'node:fs';
import { freemem, platform } from 'node:os';
import { run } from './proc.ts';

export type PressureLevel = 'normal' | 'warn' | 'critical';
export type PressureHold = PressureLevel | 'off';
export interface MemorySample {
  /** Memory the OS would hand out now. macOS counts reclaimable cache as used, so vm_stat is read there. */
  availableMb: number;
  /** macOS kernel pressure level; null where the platform reports none. Swap is not used: it is history, not demand. */
  pressure: PressureLevel | null;
  sampledAt: number;
}
export type MemorySampler = () => Promise<MemorySample>;

const LEVELS: Record<string, PressureLevel> = { '1': 'normal', '2': 'warn', '4': 'critical' };
const RANK: Record<PressureLevel, number> = { normal: 0, warn: 1, critical: 2 };
let cache: MemorySample | null = null;

async function vmStatMb(): Promise<number | null> {
  const r = await run('vm_stat', [], { timeoutMs: 3000 }).catch(() => null);
  if (!r || r.code !== 0) return null;
  const page = Number(r.stdout.match(/page size of (\d+)/)?.[1] ?? 16384);
  const pages = (name: string) => Number(r.stdout.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] ?? 0);
  return ((pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * page) / 1048576;
}

async function darwinPressure(): Promise<PressureLevel | null> {
  const r = await run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeoutMs: 3000 }).catch(() => null);
  return r && r.code === 0 ? LEVELS[r.stdout.trim()] ?? null : null;
}

/** MemAvailable counts reclaimable page cache; os.freemem() does not, and would hold work on a healthy machine. */
export function meminfoAvailableMb(text: string): number | null {
  const kb = Number(text.match(/^MemAvailable:\s+(\d+)\s*kB$/m)?.[1] ?? NaN);
  return Number.isFinite(kb) ? kb / 1024 : null;
}

export function linuxAvailableMb(file = '/proc/meminfo'): number | null {
  try { return meminfoAvailableMb(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Cached briefly: admission checks run on every scheduling tick. */
export const sampleMemory: MemorySampler = async () => {
  if (cache && Date.now() - cache.sampledAt < 10_000) return cache;
  const os = platform();
  const [available, pressure] = os === 'darwin' ? await Promise.all([vmStatMb(), darwinPressure()]) : [os === 'linux' ? linuxAvailableMb() : null, null];
  cache = { availableMb: available ?? freemem() / 1048576, pressure, sampledAt: Date.now() };
  return cache;
};

/** Null when admitted; otherwise the reason new work waits. */
export function memoryHold(sample: MemorySample, limits: { minFreeMemMb: number; holdAtPressure: PressureHold }): string | null {
  if (limits.holdAtPressure !== 'off' && sample.pressure && RANK[sample.pressure] >= RANK[limits.holdAtPressure]) return `memory pressure is ${sample.pressure}`;
  if (sample.availableMb < limits.minFreeMemMb) return `${Math.round(sample.availableMb)} MB memory available (minimum ${limits.minFreeMemMb} MB)`;
  return null;
}
