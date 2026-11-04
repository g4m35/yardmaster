import { readFile, stat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { gitOut, revParse } from './git.ts';
import { matches, normalizePattern } from './scope.ts';

/**
 * A lightweight import graph (JS/TS, Python, Go-relative) so the coordinator can see coupling that file scopes
 * miss: two tasks editing different files where one file imports the other. That is where "both pass alone,
 * broken together" contract breaks come from. Regex-based on purpose: fast, dependency-free, good enough to
 * warn agents and order work; not a compiler.
 */

export interface ImportGraph {
  files: string[];
  deps: Map<string, Set<string>>;
  rdeps: Map<string, Set<string>>;
}

const CODE = /\.(m?[jt]sx?|cjs|cts|mts|py|vue|svelte)$/;
const JS_IMPORT = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|import\s+|require\s*\(\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]/g;
const PY_FROM = /^\s*from\s+(\.+[\w.]*|[\w.]+)\s+import\s+/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+)/gm;
const MAX_FILES = 20_000;
const MAX_BYTES = 256_000;

const cache = new Map<string, ImportGraph>();

function resolveJs(from: string, spec: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const stripped = base.replace(/\.(m?js|cjs)$/, '');
  const candidates = [base, `${stripped}.ts`, `${stripped}.tsx`, `${stripped}.js`, `${stripped}.jsx`, `${stripped}.mjs`, `${stripped}.mts`, `${stripped}.cts`, `${stripped}.vue`, `${stripped}.svelte`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`];
  return candidates.find((c) => fileSet.has(c)) ?? null;
}

function resolvePy(from: string, spec: string, fileSet: Set<string>): string | null {
  let base: string;
  if (spec.startsWith('.')) {
    const dots = spec.match(/^\.+/)![0].length;
    let dir = posix.dirname(from);
    for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
    base = posix.join(dir, spec.slice(dots).replace(/\./g, '/'));
  } else base = spec.replace(/\./g, '/');
  for (const c of [`${base}.py`, `${base}/__init__.py`, `src/${base}.py`, `src/${base}/__init__.py`]) if (fileSet.has(c)) return posix.normalize(c);
  return null;
}

/**
 * Raw import specifiers per file version (`root\0path\0blob`). A HEAD move re-reads only the files whose blob
 * changed, and reads are async, so a 20k-file repo no longer freezes the hub for seconds on every commit.
 */
const specCache = new Map<string, string[]>();
const SPEC_CACHE_MAX = 200_000;

function specsOf(f: string, text: string): string[] {
  const out: string[] = [];
  if (f.endsWith('.py')) {
    for (const m of text.matchAll(PY_FROM)) out.push(m[1]!);
    for (const m of text.matchAll(PY_IMPORT)) out.push(m[1]!);
  } else for (const m of text.matchAll(JS_IMPORT)) out.push(m[1]!);
  return out;
}

async function readSpecs(root: string, entries: { path: string; blob: string }[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const todo: { path: string; key: string }[] = [];
  for (const e of entries) {
    const key = `${root}\0${e.path}\0${e.blob}`;
    const hit = specCache.get(key);
    if (hit) result.set(e.path, hit);
    else todo.push({ path: e.path, key });
  }
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const t = todo[next++]!;
      try {
        const full = join(root, t.path);
        if ((await stat(full)).size > MAX_BYTES) continue;
        const specs = specsOf(t.path, await readFile(full, 'utf8'));
        if (specCache.size >= SPEC_CACHE_MAX) specCache.delete(specCache.keys().next().value!);
        specCache.set(t.key, specs);
        result.set(t.path, specs);
      } catch {
        // unreadable or vanished: no edges
      }
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
  return result;
}

export async function importGraph(root: string, ref = 'HEAD'): Promise<ImportGraph> {
  const sha = (await revParse(root, ref)) ?? ref;
  const key = `${root}@${sha}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // "<mode> <blob> <stage>\t<path>" for every tracked file
  const listing = (await gitOut(root, ['ls-files', '-s'])).split('\n').filter(Boolean);
  const entries: { path: string; blob: string }[] = [];
  const files: string[] = [];
  for (const line of listing) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const path = line.slice(tab + 1);
    files.push(path);
    if (CODE.test(path) && entries.length < MAX_FILES) entries.push({ path, blob: line.split(' ')[1] ?? '' });
  }
  const fileSet = new Set(files);
  const specs = await readSpecs(root, entries);
  const deps = new Map<string, Set<string>>();
  const rdeps = new Map<string, Set<string>>();
  for (const [f, list] of specs) {
    const out = new Set<string>();
    for (const spec of list) {
      const r = f.endsWith('.py') ? resolvePy(f, spec, fileSet) : resolveJs(f, spec, fileSet);
      if (r) out.add(r);
    }
    out.delete(f);
    if (!out.size) continue;
    deps.set(f, out);
    for (const d of out) (rdeps.get(d) ?? rdeps.set(d, new Set()).get(d)!).add(f);
  }
  const graph = { files, deps, rdeps };
  if (cache.size > 20) cache.delete(cache.keys().next().value!);
  cache.set(key, graph);
  return graph;
}

export function filesIn(graph: ImportGraph, scope: string[]): string[] {
  if (!scope.length) return [];
  return graph.files.filter((f) => scope.some((p) => matches(f, p)));
}

export interface Coupling {
  /** File the other task edits... */
  theirs: string;
  /** ...and the file in this task's scope that is tied to it. */
  mine: string;
  direction: 'imports' | 'imported-by';
}

/** Direct import edges between two scopes that don't overlap themselves. */
export function coupling(graph: ImportGraph, mine: string[], theirs: string[]): Coupling[] {
  const a = new Set(filesIn(graph, mine.map(normalizePattern)));
  const b = new Set(filesIn(graph, theirs.map(normalizePattern)));
  const out: Coupling[] = [];
  for (const f of a) {
    if (b.has(f)) continue;
    for (const d of graph.deps.get(f) ?? []) if (b.has(d) && !a.has(d)) out.push({ mine: f, theirs: d, direction: 'imports' });
    for (const r of graph.rdeps.get(f) ?? []) if (b.has(r) && !a.has(r)) out.push({ mine: f, theirs: r, direction: 'imported-by' });
  }
  return out.slice(0, 20);
}

export const _test = { resolveJs, resolvePy, dirname };
