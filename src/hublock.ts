import { existsSync, linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The takeover lock: held for the moment it takes to replace a stale hub lock. A leftover one from a crash expires. */
async function takeTakeover(file: string, mine: string): Promise<boolean> {
  const takeover = `${file}.takeover`;
  try {
    linkSync(mine, takeover);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const holder = readOwner(takeover);
  const age = Date.now() - (statSync(takeover, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
  if (age > 10_000 || (holder && !(await stillOwned(holder, takeover)) && holder.pid !== process.pid)) rmSync(takeover, { force: true });
  return false;
}

export class HubAlreadyRunning extends Error {}

/** Whether this process still holds the lock: a hub checks this as it runs and stops if another took it over. */
export function holdsHubLock(file = join(yardHome(), 'hub.lock')): boolean {
  return held.has(file) && readOwner(file)?.pid === process.pid;
}

/** Takes the lock or throws HubAlreadyRunning. Returns the release function. */
export async function acquireHubLock(file = join(yardHome(), 'hub.lock')): Promise<() => void> {
  const started = await processStartTime(process.pid).catch(() => null);
  const mine = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(mine, `${process.pid} ${started ?? ''}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
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
        if (age < 10_000) {
          await sleep(50);
          continue;
        }
      }
      // Stale. Taking it over must never leave the lock path empty, or a third hub could link its own lock in while
      // we look. So one takeover at a time (a second lock, held only for this), and the stale lock is replaced in a
      // single atomic rename. Plain acquirers can't get in meanwhile: their link fails while the old file exists.
      if (!(await takeTakeover(file, mine))) {
        await sleep(50);
        continue;
      }
      try {
        // Released meanwhile: take it the normal way instead, so we never replace a lock someone just linked in.
        if (!existsSync(file)) continue;
        const again = readOwner(file);
        if (again && (await stillOwned(again, file))) {
          throw new HubAlreadyRunning(`A Yardmaster hub is already running for ${dirname(file)} (pid ${again.pid}).`);
        }
        const replacement = `${mine}.new`;
        writeFileSync(replacement, readFileSync(mine), { mode: 0o600 });
        renameSync(replacement, file);
        held.add(file);
        return () => {
          if (!held.delete(file)) return;
          if (readOwner(file)?.pid === process.pid) rmSync(file, { force: true });
        };
      } finally {
        if (readOwner(`${file}.takeover`)?.pid === process.pid) rmSync(`${file}.takeover`, { force: true });
      }
    }
    throw new HubAlreadyRunning(`Could not take the hub lock at ${file}: another hub kept starting at the same moment.`);
  } finally {
    rmSync(mine, { force: true });
  }
}
