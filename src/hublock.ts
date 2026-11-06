import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { yardHome } from './paths.ts';
import { processStartTime } from './proc.ts';

/**
 * One hub per Yardmaster home. A second hub on the same database would run startup recovery and treat the first
 * hub's agents as orphans, killing them and resetting merges in progress.
 *
 * The lock file holds the owner's pid and process start time, and it appears with that content in one step (written
 * to a private file, then hard-linked into place), so nobody ever reads a half-written lock. A lock whose owner has
 * exited, or whose pid now belongs to a different process, is taken over: renamed aside first, so two hubs taking
 * over the same stale lock can't both win.
 */

const held = new Set<string>();

interface Owner {
  pid: number;
  started: number | null;
}

function readOwner(file: string): Owner | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const [pid, started] = text.trim().split(/\s+/).map(Number);
  return pid && Number.isInteger(pid) && pid > 0 ? { pid, started: started && Number.isFinite(started) ? started : null } : null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else, which still means it's running.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether the lock's owner is still the process that wrote it (ps reports start times to the second). */
async function stillOwned(owner: Owner, file: string): Promise<boolean> {
  if (owner.pid === process.pid) return held.has(file);
  if (!alive(owner.pid)) return false;
  if (owner.started === null) return true;
  const now = await processStartTime(owner.pid).catch(() => null);
  return now === null || Math.abs(now - owner.started) < 2000;
}

export class HubAlreadyRunning extends Error {}

/** Takes the lock or throws HubAlreadyRunning. Returns the release function. */
export async function acquireHubLock(file = join(yardHome(), 'hub.lock')): Promise<() => void> {
  const started = await processStartTime(process.pid).catch(() => null);
  const mine = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(mine, `${process.pid} ${started ?? ''}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(mine, file);
        held.add(file);
        return () => {
          if (!held.delete(file)) return;
          if (readOwner(file)?.pid === process.pid) rmSync(file, { force: true });
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const owner = readOwner(file);
      if (owner && (await stillOwned(owner, file))) {
        throw new HubAlreadyRunning(`A Yardmaster hub is already running for ${dirname(file)} (pid ${owner.pid}). Stop it first with "ym hub stop", or set YARDMASTER_HOME to use a separate home.`);
      }
      if (!owner) {
        // Unreadable content: only a lock written by some other tool or a damaged disk. Leave a fresh one alone.
        const age = Date.now() - (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0);
        if (age < 10_000) continue;
      }
      // Stale. Move it aside atomically; if someone else already replaced it, the next round sees theirs.
      const aside = `${file}.stale.${randomBytes(4).toString('hex')}`;
      try {
        renameSync(file, aside);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      const moved = readOwner(aside);
      if (moved && (await stillOwned(moved, file))) {
        // We moved a live hub's lock: it was taken over between our check and the rename. Put it back and yield.
        try {
          linkSync(aside, file);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
        rmSync(aside, { force: true });
        throw new HubAlreadyRunning(`A Yardmaster hub is already running for ${dirname(file)} (pid ${moved.pid}).`);
      }
      rmSync(aside, { force: true });
    }
    throw new HubAlreadyRunning(`Could not take the hub lock at ${file}: another hub kept starting at the same moment.`);
  } finally {
    rmSync(mine, { force: true });
  }
}
