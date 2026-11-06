import { createReadStream, createWriteStream, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { git, revParse } from './git.ts';
import { paths } from './paths.ts';
import { shortId } from './text.ts';
import type { BranchTransport } from './worker.ts';

/**
 * Moves commits between machines as git bundles over the hub's HTTP API, so machines do not need a
 * shared remote, SSH access to each other, or GitHub credentials.
 */
/** Bundles can be large; this only stops a transfer that has stalled for good. */
const BUNDLE_TIMEOUT_MS = 10 * 60_000;

export function httpTransport(baseUrl: string, token: string, machineId: string): BranchTransport {
  const url = baseUrl.replace(/\/$/, '');
  const auth = { authorization: `Bearer ${token}` };
  return {
    async fetchBase(project, repoPath, sha) {
      const have = await revParse(repoPath, 'HEAD');
      const res = await fetch(`${url}/api/projects/${project.id}/base-bundle${have ? `?have=${have}` : ''}`, { headers: auth, signal: AbortSignal.timeout(BUNDLE_TIMEOUT_MS) });
      if (!res.ok || !res.body) throw new Error(`Hub refused the base bundle (${res.status}).`);
      const branch = res.headers.get('x-yardmaster-branch') ?? 'yardmaster/integration';
      const file = join(paths.tmp(), `${shortId('b')}.bundle`);
      await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(file));
      try {
        // Into a private ref namespace: never overwrites the user's local branches.
        await git(repoPath, ['fetch', '--no-tags', file, `+refs/heads/${branch}:refs/yardmaster/hub/${branch}`]);
      } finally {
        rmSync(file, { force: true });
      }
      if (!(await revParse(repoPath, sha))) throw new Error(`Commit ${sha.slice(0, 10)} from the hub is still missing after fetching.`);
    },
    async uploadBranch(task, repoPath, branch, base) {
      const file = join(paths.tmp(), `${shortId('u')}.bundle`);
      const withBase = await git(repoPath, ['bundle', 'create', file, `refs/heads/${branch}`, `^${base}`], { allowFail: true });
      if (withBase.code !== 0) await git(repoPath, ['bundle', 'create', file, `refs/heads/${branch}`]);
      try {
        const head = (await revParse(repoPath, `refs/heads/${branch}`)) ?? '';
        const q = new URLSearchParams({ branch, machine: machineId, head });
        const res = await fetch(`${url}/api/tasks/${task.id}/bundle?${q}`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/octet-stream', 'content-length': String(statSync(file).size) },
          body: Readable.toWeb(createReadStream(file)) as unknown as BodyInit,
          duplex: 'half',
          signal: AbortSignal.timeout(BUNDLE_TIMEOUT_MS),
        } as RequestInit & { duplex: 'half' });
        const body = (await res.json()) as { ok: boolean; error?: string };
        if (!body.ok) throw new Error(body.error ?? `upload failed (${res.status})`);
      } finally {
        rmSync(file, { force: true });
      }
    },
  };
}
