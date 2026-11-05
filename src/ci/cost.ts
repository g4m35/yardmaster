/**
 * What GitHub charges for a job: every job is rounded up to a whole minute, then priced by runner type.
 * Rates are GitHub's published list prices (docs.github.com, "Actions runner pricing", checked 2026-11).
 * Standard runners are free in public repositories; self-hosted and third-party runners are not billed by GitHub.
 */

export type RunnerKind = 'linux-slim' | 'linux' | 'linux-arm' | 'windows' | 'windows-arm' | 'macos' | 'macos-large' | 'macos-xlarge' | 'other';

export const RATE_USD: Record<Exclude<RunnerKind, 'other'>, number> = {
  'linux-slim': 0.002,
  linux: 0.006,
  'linux-arm': 0.005,
  windows: 0.01,
  'windows-arm': 0.01,
  macos: 0.062,
  // Larger runners are billed even in public repos (on Team and Enterprise Cloud they draw from included usage first).
  'macos-large': 0.077,
  'macos-xlarge': 0.102,
};

export const isLargerRunner = (k: RunnerKind): boolean => k === 'macos-large' || k === 'macos-xlarge';

/** Which runner a job asked for, from its `runs-on` labels. Unrecognized labels are self-hosted or third-party. */
export function runnerKind(labels: string[]): RunnerKind {
  const ls = labels.map((l) => l.toLowerCase());
  if (ls.includes('self-hosted')) return 'other';
  for (const l of ls) {
    if (l === 'ubuntu-slim') return 'linux-slim';
    if (/^ubuntu-(latest|\d{2}\.\d{2})-arm$/.test(l)) return 'linux-arm';
    if (/^ubuntu-(latest|\d{2}\.\d{2})$/.test(l)) return 'linux';
    // Image variants such as windows-2025-vs2026 and windows-11-vs2026-arm bill like the base image.
    if (/^windows-(latest|\d{4}|11)(-vs\d{4})?-arm$/.test(l)) return 'windows-arm';
    if (/^windows-(latest|\d{4})(-vs\d{4})?$/.test(l)) return 'windows';
    if (/^macos-(latest|\d+)-xlarge$/.test(l)) return 'macos-xlarge';
    if (/^macos-(latest|\d+)(-intel)?-large$/.test(l)) return 'macos-large';
    if (/^(macos-(latest|\d+)(-intel)?|xcode-\d+)$/.test(l)) return 'macos';
  }
  return 'other';
}

export interface JobTiming {
  labels: string[];
  startedAt: string | null;
  completedAt: string | null;
}

export function rawMinutes(job: JobTiming): number {
  if (!job.startedAt || !job.completedAt) return 0;
  const ms = Date.parse(job.completedAt) - Date.parse(job.startedAt);
  return ms > 0 ? ms / 60_000 : 0;
}

/** GitHub rounds each job up to the next whole minute. */
export function billedMinutes(job: JobTiming): number {
  const m = rawMinutes(job);
  return m > 0 ? Math.ceil(m - 1e-9) : 0;
}

export interface JobCost {
  kind: RunnerKind;
  raw: number;
  billed: number;
  usd: number;
}

export function jobCost(job: JobTiming, repoPrivate: boolean): JobCost {
  const kind = runnerKind(job.labels);
  const raw = rawMinutes(job);
  const billed = billedMinutes(job);
  if (kind === 'other') return { kind, raw, billed, usd: 0 };
  const free = !repoPrivate && !isLargerRunner(kind);
  return { kind, raw, billed, usd: free ? 0 : billed * RATE_USD[kind] };
}
