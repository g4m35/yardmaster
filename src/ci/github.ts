/**
 * A small GitHub REST client on plain fetch, shared by the `ym ci` commands and the CI guard Action (which is
 * bundled into one file, so this must not pull in anything heavy). The token is only ever sent to the API host.
 */

export class GitHubError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, message: string) {
    super(`GitHub API ${status} for ${path}: ${message}`);
    this.status = status;
    this.path = path;
  }
}

export interface GitHub {
  readonly base: string;
  readonly authenticated: boolean;
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  /** Follows `Link: rel="next"`. `key` picks the array out of wrapped responses like { workflow_runs: [...] }. */
  paginate<T>(path: string, key: string | null, query?: Record<string, string | number | undefined>, max?: number): Promise<T[]>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export function apiBase(): string {
  return (process.env.YM_GITHUB_API ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
}

function withQuery(url: string, query?: Record<string, string | number | undefined>): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
  return u.toString();
}

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1]!;
  }
  return null;
}

export function createGitHub(token: string | null, opts: { base?: string; timeoutMs?: number; retries?: number; retryDelayMs?: number } = {}): GitHub {
  const base = (opts.base ?? apiBase()).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const retries = opts.retries ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'yardmaster-ci',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  async function send(method: string, url: string, body?: unknown): Promise<Response> {
    // GitHub's API returns the odd 502/503 under load; reads are safe to retry, writes are not.
    const attempts = method === 'GET' ? retries + 1 : 1;
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(url, {
          method,
          headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status >= 500 && i < attempts - 1) {
          await res.body?.cancel();
          await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** i));
          continue;
        }
        return res;
      } catch (err) {
        if (i >= attempts - 1) throw err;
        await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** i));
      }
    }
  }

  async function request(method: string, url: string, body?: unknown): Promise<{ data: unknown; link: string | null }> {
    // Never follow a link (pagination or otherwise) to a different host with the token attached.
    if (new URL(url).origin !== new URL(base).origin) throw new Error(`Refusing to call ${new URL(url).origin}: not the GitHub API host`);
    const res = await send(method, url, body);
    const text = await res.text();
    const path = new URL(url).pathname;
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? message;
      } catch {
        // not JSON
      }
      if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
        message = `rate limit reached${reset ? `; resets ${new Date(reset).toLocaleTimeString()}` : ''}`;
      }
      throw new GitHubError(res.status, path, message);
    }
    return { data: text ? JSON.parse(text) : null, link: res.headers.get('link') };
  }

  return {
    base,
    authenticated: !!token,
    async get<T>(path: string, query?: Record<string, string | number | undefined>) {
      return (await request('GET', withQuery(`${base}${path}`, query))).data as T;
    },
    async paginate<T>(path: string, key: string | null, query?: Record<string, string | number | undefined>, max = 5000) {
      const out: T[] = [];
      let url: string | null = withQuery(`${base}${path}`, { per_page: 100, ...query });
      while (url && out.length < max) {
        const { data, link } = await request('GET', url);
        const items = (key ? (data as Record<string, unknown>)[key] : data) as T[] | undefined;
        if (!Array.isArray(items)) break;
        out.push(...items);
        url = nextLink(link);
      }
      return out.slice(0, max);
    },
    async post<T>(path: string, body: unknown) {
      return (await request('POST', `${base}${path}`, body)).data as T;
    },
  };
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** owner/name from any GitHub remote URL form (https, ssh, scp-like). Null for other hosts. */
export function repoSlugFromUrl(url: string, host = 'github.com'): string | null {
  const h = host.replace(/\./g, '\\.');
  const m = url.trim().match(new RegExp(`^(?:https?://(?:[^@/]+@)?${h}/|ssh://(?:[^@/]+@)?${h}(?::\\d+)?/|[^@\\s]+@${h}:)([^/\\s]+)/([^/\\s]+?)(?:\\.git)?/?$`, 'i'));
  return m ? `${m[1]}/${m[2]}` : null;
}
