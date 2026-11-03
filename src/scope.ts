/**
 * File-scope reasoning. A scope is a list of repo-relative globs ("src/auth/**", "README.md").
 * Overlap checks are deliberately conservative: a false "overlap" only costs parallelism,
 * a missed overlap costs a merge conflict and wasted tokens.
 */

export function normalizePattern(p: string): string {
  let s = p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  if (s.endsWith('/')) s += '**';
  return s;
}

export function globToRegExp(glob: string): RegExp {
  const g = normalizePattern(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        re += `(?:${g.slice(i + 1, end).split(',').map(escapeRe).join('|')})`;
        i = end;
      }
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function matches(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(normalizePattern(path));
}

function staticPrefix(pattern: string): string {
  const g = normalizePattern(pattern);
  const idx = g.search(/[*?{[]/);
  return idx === -1 ? g : g.slice(0, idx);
}

function hasGlob(pattern: string): boolean {
  return /[*?{[]/.test(pattern);
}

export function patternsOverlap(a: string, b: string): boolean {
  const pa = normalizePattern(a);
  const pb = normalizePattern(b);
  if (pa === '**' || pb === '**' || pa === pb) return true;
  if (!hasGlob(pa) && matches(pa, pb)) return true;
  if (!hasGlob(pb) && matches(pb, pa)) return true;
  if (!hasGlob(pa) && !hasGlob(pb)) {
    return pa.startsWith(pb + '/') || pb.startsWith(pa + '/');
  }
  // Two globs: overlap unless their literal prefixes diverge.
  const sa = staticPrefix(pa);
  const sb = staticPrefix(pb);
  return sa.startsWith(sb) || sb.startsWith(sa);
}

export function scopesOverlap(a: string[], b: string[]): string[] {
  const hits: string[] = [];
  for (const x of a) for (const y of b) if (patternsOverlap(x, y)) hits.push(x === y ? x : `${x} ~ ${y}`);
  return hits;
}

export function inScope(path: string, scope: string[]): boolean {
  return scope.some((p) => matches(path, p));
}

const PATH_TOKEN = /(?:^|[\s`'"(])((?:[\w@.-]+\/)*[\w@-]+\.[a-zA-Z0-9]{1,8}|(?:[\w@.-]+\/)+(?:\*\*?)?)(?=$|[\s`'"),:;])/g;
const NOT_PATHS = /^(e\.g|i\.e|etc|vs|v\d|\d+\.\d+)$/i;

/** Pulls likely file paths out of a plain-language request so non-technical users don't have to declare scopes. */
export function inferScope(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(PATH_TOKEN)) {
    const p = m[1]!.replace(/[.,]$/, '');
    if (NOT_PATHS.test(p) || /^https?:/.test(p) || p.includes('://')) continue;
    if (!p.includes('/') && !/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|md|json|ya?ml|toml|css|scss|html|vue|svelte|sql|sh|txt|c|h|cpp|cs|php)$/i.test(p)) continue;
    found.add(normalizePattern(p));
  }
  return [...found];
}
