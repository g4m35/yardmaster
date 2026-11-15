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

export const MAX_SCOPE_PATTERNS = 4096;
export const MAX_PATTERN_LENGTH = 1024;
export const MAX_WILDCARDS = 64;

export function validatePattern(pattern: string): boolean {
  return pattern.length <= MAX_PATTERN_LENGTH && (pattern.match(/[*?{]/g)?.length ?? 0) <= MAX_WILDCARDS;
}

export function validPatterns(patterns: string[], limit = MAX_SCOPE_PATTERNS): boolean {
  return Array.isArray(patterns) && patterns.length <= limit && patterns.every(validatePattern);
}

type GlobToken = { kind: 'literal'; choices: string[] } | { kind: 'star' | 'globstar' | 'directory' | 'one' };

/** Retains the old test interface, but uses dynamic programming instead of a backtracking RegExp. */
export function globToRegExp(glob: string): { test(path: string): boolean } {
  if (!validatePattern(glob)) return { test: () => true };
  const g = normalizePattern(glob);
  const tokens: GlobToken[] = [];
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        tokens.push({ kind: slash ? 'directory' : 'globstar' });
        i += slash ? 2 : 1;
      } else tokens.push({ kind: 'star' });
    } else if (c === '?') tokens.push({ kind: 'one' });
    else if (c === '{' && g.indexOf('}', i) !== -1) {
      const end = g.indexOf('}', i);
      tokens.push({ kind: 'literal', choices: g.slice(i + 1, end).split(',') });
      i = end;
    } else tokens.push({ kind: 'literal', choices: [c] });
  }
  return { test(path) {
    let previous = new Uint8Array(path.length + 1);
    previous[0] = 1;
    for (const token of tokens) {
      const next = new Uint8Array(path.length + 1);
      if (token.kind === 'star' || token.kind === 'globstar' || token.kind === 'directory') {
        let reachable = false;
        for (let i = 0; i <= path.length; i++) {
          if (i && (token.kind === 'star' ? path[i - 1] === '/' : /[\n\r\u2028\u2029]/.test(path[i - 1]!))) reachable = false;
          if (token.kind === 'directory') {
            if (previous[i] || (reachable && path[i - 1] === '/')) next[i] = 1;
          } else if (previous[i] || reachable) next[i] = 1;
          reachable ||= previous[i] === 1;
        }
      } else {
        for (let i = 0; i < path.length + 1; i++) {
          if (!previous[i]) continue;
          if (token.kind === 'one') { if (i < path.length && path[i] !== '/') next[i + 1] = 1; }
          else if (token.kind === 'literal') for (const choice of token.choices) if (path.startsWith(choice, i)) next[i + choice.length] = 1;
        }
      }
      previous = next;
    }
    for (let i = 0; i <= path.length; i++) {
      if (previous[i] && (i === path.length || (path[i] === '/' && !/[\n\r\u2028\u2029]/.test(path.slice(i))))) return true;
    }
    return false;
  } };
}

export function matches(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(normalizePattern(path));
}

function staticPrefix(pattern: string): string {
  const g = normalizePattern(pattern);
  const idx = g.search(/[*?{]/);
  return idx === -1 ? g : g.slice(0, idx);
}

function hasGlob(pattern: string): boolean {
  return /[*?{]/.test(pattern);
}

export function patternsOverlap(a: string, b: string): boolean {
  if (!validPatterns([a, b])) return true;
  const pa = normalizePattern(a);
  const pb = normalizePattern(b);
  if (pa === '**' || pb === '**' || pa === pb) return true;
  if (!hasGlob(pa) && !hasGlob(pb)) {
    return pa.startsWith(pb + '/') || pb.startsWith(pa + '/');
  }
  if (!hasGlob(pa) && matches(pa, pb)) return true;
  if (!hasGlob(pb) && matches(pb, pa)) return true;
  // Two globs: overlap unless their literal prefixes diverge.
  const sa = staticPrefix(pa);
  const sb = staticPrefix(pb);
  return sa.startsWith(sb) || sb.startsWith(sa);
}

export function scopesOverlap(a: string[], b: string[]): string[] {
  // Legacy declarations above today's limits must conservatively overlap, never stall the shared scheduler.
  if (!validPatterns(a) || !validPatterns(b)) return ['scope exceeds safe matching limits'];
  const hits: string[] = [];
  for (const x of a) for (const y of b) if (patternsOverlap(x, y)) hits.push(x === y ? x : `${x} ~ ${y}`);
  return hits;
}

export function inScope(path: string, scope: string[]): boolean {
  if (!validPatterns(scope)) return true;
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
