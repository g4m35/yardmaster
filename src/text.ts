import { createHash } from 'node:crypto';

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

export function shortId(prefix: string): string {
  const n = Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 5);
  return `${prefix}-${n}`;
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'it', 'this', 'that', 'be',
  'please', 'make', 'sure', 'so', 'we', 'i', 'can', 'should', 'into', 'from', 'by', 'as', 'at',
]);

export function wordSet(s: string): Set<string> {
  const words = s
    .toLowerCase()
    .replace(/[^a-z0-9_./]+/g, ' ')
    .split(' ')
    .map((w) => w.replace(/^[./]+|[./]+$/g, '').replace(/(?<=\w{3})(ing|es|s)$/, ''))
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return new Set(words);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export function taskFingerprint(title: string, prompt: string): string {
  return [...wordSet(`${title} ${prompt}`)].sort().join(' ');
}

/** Normalizes noisy failure output (timestamps, durations, hex ids, line numbers) so repeated failures hash identically. */
export function errorFingerprint(output: string): string {
  const normalized = output
    .split('\n')
    .slice(-40)
    .join('\n')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '<ts>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\d+(\.\d+)?\s?(ms|s|sec|seconds|m)\b/g, '<dur>')
    .replace(/:\d+:\d+/g, ':<l>:<c>')
    .replace(/\/[^\s'"]*\/(?=[^/\s]+)/g, '<path>/')
    .replace(/\s+/g, ' ')
    .trim();
  return sha1(normalized).slice(0, 16);
}

export function tail(s: string, lines: number, maxChars = 4000): string {
  const out = s.split('\n').slice(-lines).join('\n');
  return out.length > maxChars ? out.slice(-maxChars) : out;
}

export function clip(s: string | null | undefined, max: number): string {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/** Stable JSON for fingerprinting tool-call inputs regardless of key order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(',')}}`;
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '-';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
