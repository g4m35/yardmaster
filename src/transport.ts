import { createReadStream, createWriteStream, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { git, revParse } from './git.ts';
import { paths } from './paths.ts';
import { shortId } from './text.ts';
import { currentProcessScopeSignal, withProcessScope } from './proc.ts';
import type { BranchTransport } from './worker.ts';

/**
 * Moves commits between machines as git bundles over the hub's HTTP API, so machines do not need a
 * shared remote, SSH access to each other, or GitHub credentials.
 */
/** Bundles can be large; this only stops a transfer that has stalled for good. */
const BUNDLE_TIMEOUT_MS = 10 * 60_000;

// Standalone transfers still own their local Git groups. A worker's inherited scope
// supplies the durable token hooks and must never be hidden by a nested scope.
function transferScope<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  return currentProcessScopeSignal() ? work() : withProcessScope({ signal }, work);
}
function transferSignal(signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, currentProcessScopeSignal(), AbortSignal.timeout(BUNDLE_TIMEOUT_MS)].filter((value): value is AbortSignal => !!value));
}

export function httpTransport(baseUrl: string, token: string, machineId: string): BranchTransport {
  const url = baseUrl.replace(/\/$/, '');
  const auth = { authorization: `Bearer ${token}` };
  return {
    fetchBase(project, repoPath, sha, signal) {
      return transferScope(signal, async () => {
        const ownedSignal = transferSignal(signal);
        ownedSignal.throwIfAborted();
        const have = await revParse(repoPath, 'HEAD');
        const res = await fetch(`${url}/api/projects/${project.id}/base-bundle${have ? `?have=${have}` : ''}`, { headers: auth, redirect: 'error', signal: ownedSignal });
        if (!res.ok || !res.body) throw new Error(`Hub refused the base bundle (${res.status}).`);
        const branch = res.headers.get('x-yardmaster-branch') ?? 'yardmaster/integration';
        const file = join(paths.tmp(), `${shortId('b')}.bundle`);
        try {
          await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(file), { signal: ownedSignal });
          ownedSignal.throwIfAborted();
          // Into a private ref namespace: never overwrites the user's local branches.
          await git(repoPath, ['fetch', '--no-tags', file, `+refs/heads/${branch}:refs/yardmaster/hub/${branch}`]);
        } finally {
          rmSync(file, { force: true });
        }
        if (!(await revParse(repoPath, sha))) throw new Error(`Commit ${sha.slice(0, 10)} from the hub is still missing after fetching.`);
      });
    },
    uploadBranch(task, repoPath, branch, base, signal) {
      return transferScope(signal, async () => {
        const ownedSignal = transferSignal(signal);
        if (!Number.isSafeInteger(task.generation) || task.generation < 1) throw new Error('Upload requires a valid claim generation. Upgrade the worker and reclaim the task.');
        if (task.assignee !== `machine:${machineId}` || task.status !== 'ready' || !task.head_sha) throw new Error('Upload requires the current ready claim and its accepted commit.');
        ownedSignal.throwIfAborted();
        const file = join(paths.tmp(), `${shortId('u')}.bundle`);
        try {
          const withBase = await git(repoPath, ['bundle', 'create', file, `refs/heads/${branch}`, `^${base}`], { allowFail: true });
          if (withBase.code !== 0) await git(repoPath, ['bundle', 'create', file, `refs/heads/${branch}`]);
          const head = (await revParse(repoPath, `refs/heads/${branch}`)) ?? '';
          if (head !== task.head_sha || branch !== task.branch) throw new Error('Local branch moved since verification; upload refused.');
          const q = new URLSearchParams({ branch, machine: machineId, head, generation: String(task.generation) });
          const res = await fetch(`${url}/api/tasks/${task.id}/bundle?${q}`, {
            method: 'POST',
            redirect: 'error',
            headers: { ...auth, 'content-type': 'application/octet-stream', 'content-length': String(statSync(file).size) },
            body: Readable.toWeb(createReadStream(file)) as unknown as BodyInit,
            duplex: 'half',
            signal: ownedSignal,
          } as RequestInit & { duplex: 'half' });
          const body = (await res.json()) as { ok: boolean; error?: string; result?: { head?: string } };
          if (!res.ok || !body.ok) throw new Error(body.error ?? `upload failed (${res.status})`);
          if (body.result?.head !== task.head_sha) throw new Error('Hub did not acknowledge the accepted commit.');
          return { head: body.result.head };
        } finally {
          rmSync(file, { force: true });
        }
      });
    },
  };
}
