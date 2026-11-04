/**
 * What GitHub charges for a job: every job is rounded up to a whole minute, then priced by runner type.
 * Rates are GitHub's published list prices (docs.github.com, "Actions runner pricing", checked 2026-11).
 * Standard runners are free in public repositories; self-hosted and third-party runners are not billed by GitHub.
 */

export type RunnerKind = 'linux-slim' | 'linux' | 'linux-arm' | 'windows' | 'windows-arm' | 'macos' | 'macos-larger' | 'other';

export const RATE_USD: Record<Exclude<RunnerKind, 'other'>, number> = {
  'linux-slim': 0.002,
  linux: 0.006,
  'linux-arm': 0.005,
  windows: 0.01,
  'windows-arm': 0.01,
  macos: 0.062,
  // Larger macOS runners cost more; GitHub bills them from the first minute even in public repos. The standard
  // macOS rate is a floor, and reports flag these jobs.
  'macos-larger': 0.062,
};

/** Which runner a job asked for, from its `runs-on` labels. Unrecognized labels are self-hosted or third-party. */
export function runnerKind(labels: string[]): RunnerKind {
  const ls = labels.map((l) => l.toLowerCase());
  if (ls.includes('self-hosted')) return 'other';
  for (const l of ls) {
    if (l === 'ubuntu-slim') return 'linux-slim';
    if (/^ubuntu-(latest|\d{2}\.\d{2})-arm$/.test(l)) return 'linux-arm';
    if (/^ubuntu-(latest|\d{2}\.\d{2})$/.test(l)) return 'linux';
    if (/^windows-(latest|\d{4}|11)-arm$/.test(l)) return 'windows-arm';
    if (/^windows-(latest|\d{4})$/.test(l)) return 'windows';
    if (/^macos-(latest|\d+)(-intel)?-(large|xlarge)$/.test(l)) return 'macos-larger';
    if (/^macos-(latest|\d+)(-intel)?$/.test(l)) return 'macos';
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
  const free = !repoPrivate && kind !== 'macos-larger';
  return { kind, raw, billed, usd: free ? 0 : billed * RATE_USD[kind] };
}
