import type { Coordinator } from './coordinator.ts';
import { routingFor } from './config.ts';
import { clip, formatUsd } from './text.ts';
import { scopesOverlap } from './scope.ts';

export interface Warning {
  key: string;
  taskId: string | null;
  projectId: string | null;
  message: string;
  since: number;
}

/**
 * Fleet-level supervision. The per-run watchdog catches an agent that is clearly stuck; this looks at the
 * whole yard for softer problems a person would want to know about: work that should be running but isn't,
 * reservations nobody is using, agents that run without producing changes, and spend that will hit the cap.
 * Like the watchdog, it is plain code: watching costs no tokens.
 */
export class Supervisor {
  private readonly coord: Coordinator;
  private warnings = new Map<string, Warning>();
  private readyToStartSince = new Map<string, number>();

  constructor(coord: Coordinator) {
    this.coord = coord;
  }

  current(projectId?: string | null): Warning[] {
    return [...this.warnings.values()].filter((w) => !projectId || !w.projectId || w.projectId === projectId);
  }

  private raise(w: Omit<Warning, 'since'>, now: number, level: 'warn' | 'info' = 'warn'): void {
    if (this.warnings.has(w.key)) return;
    this.warnings.set(w.key, { ...w, since: now });
    this.coord.event(w.projectId, w.taskId, level, 'supervisor.warning', w.message);
  }

  check(now = Date.now()): Warning[] {
    const seen = new Set<string>();
    const keep = (key: string) => seen.add(key);
    const machines = this.coord.listMachines().filter((m) => now - m.last_seen < 60_000);

    for (const project of this.coord.listProjects()) {
      const cfg = this.coord.configFor(project.id).supervision;
      const integrationProcess = this.coord.getMeta(`integration_process:${project.id}`);
      if (integrationProcess && /"held"\s*:\s*true/.test(integrationProcess)) {
        const key = `integration-process:${project.id}`;
        keep(key);
        this.raise({ key, projectId: project.id, taskId: null, message: `Integration for ${project.name} is held until its previous process is confirmed stopped. Work is preserved. Restart the hub for identity-proven recovery; only for an unregistered spawning window, inspect the processes and use ym recover --confirm-stopped ${project.id} --note "how exit was verified".` }, now);
      }

      // Running agents that are burning time and money without touching any files.
      for (const t of this.coord.listTasks(project.id, ['running'])) {
        const run = this.coord.latestRun(t.id);
        if (!run || t.assignee?.startsWith('session:')) continue;
        const minutes = (now - run.started_at) / 60_000;
        const key = `slow:${run.id}`;
        if (minutes >= cfg.slowProgressMinutes && run.touched.length === 0) {
          keep(key);
          this.raise({ key, taskId: t.id, projectId: project.id, message: `"${clip(t.title, 60)}" has run ${minutes < 1 ? 'for under a minute' : `${Math.round(minutes)} min`} without changing any files (${formatUsd(run.cost_usd)} so far). Check its activity, redirect it, or stop it.` }, now);
        }
      }

      // Work that could start but hasn't: explain why instead of leaving people guessing.
      for (const t of this.coord.listTasks(project.id, ['queued'])) {
        if (this.coord.blocker(t, now)) {
          this.readyToStartSince.delete(t.id);
          continue;
        }
        const since = this.readyToStartSince.get(t.id) ?? now;
        this.readyToStartSince.set(t.id, since);
        if (now - since < cfg.queueStallMinutes * 60_000) continue;
        const key = `stall:${t.id}`;
        keep(key);
        const capable = machines.filter((m) => m.info.repos?.[project.id] && (t.agent ? m.info.agents.includes(t.agent) : routingFor(this.coord.configFor(project.id), t.tier).some((a) => m.info.agents.includes(a))));
        const why = !machines.length
          ? 'no machine is online. Start the hub with "ym hub start".'
          : !capable.length
            ? t.agent
              ? `no online machine has ${t.agent} installed for this repo.`
              : `no online machine has an agent from the ${t.tier} list (${routingFor(this.coord.configFor(project.id), t.tier).join(', ')}) for this repo.`
            : capable.every((m) => m.info.running >= m.info.maxParallel)
              ? 'every agent slot is busy. It will start when one frees up, or raise maxParallel.'
              : 'machines are holding new work (low disk, high load, or low memory). See Machines.';
        this.raise({ key, taskId: t.id, projectId: project.id, message: `"${clip(t.title, 60)}" is ready but hasn't started: ${why}` }, now, 'info');
      }

      // Reservations held by sessions that went away, blocking queued work.
      const sessions = new Map(this.coord.listSessions(project.id).map((s) => [s.id, s]));
      const queued = this.coord.listTasks(project.id, ['queued']);
      for (const lock of this.coord.activeLocks(project.id)) {
        if (!lock.holder.startsWith('session:')) continue;
        const s = sessions.get(lock.holder);
        const idle = s ? now - s.last_seen : Infinity;
        if (idle < cfg.idleLockMinutes * 60_000) continue;
        const blocking = queued.filter((t) => scopesOverlap(this.coord.effectiveScope(t), [lock.pattern]).length);
        if (!blocking.length) continue;
        this.coord.releaseLocks(project.id, lock.holder, [lock.pattern]);
        this.coord.event(project.id, null, 'warn', 'supervisor.released', `Released ${lock.pattern}: ${lock.holder.slice(8)} reserved it but has been gone ${Number.isFinite(idle) ? Math.round(idle / 60_000) + ' min' : 'a while'}, and ${blocking.length} task(s) were waiting on it.`);
      }
    }

    // Budget burn rate: warn before the daily cap stops the fleet mid-day.
    const first = this.coord.listProjects()[0];
    const daily = first ? this.coord.configFor(first.id).budget.dailyUsd : null;
    const projected = this.projectedBudgetOut(now);
    if (daily !== null && projected !== null && first) {
      const mins = (projected - now) / 60_000;
      const key = `budget:${new Date(now).toDateString()}`;
      if (mins > 0 && mins <= this.coord.configFor(first.id).supervision.budgetWarnMinutes) {
        keep(key);
        this.raise({ key, taskId: null, projectId: null, message: `At the current pace, today's $${daily} budget runs out around ${new Date(projected).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Raise budget.dailyUsd, switch to the "frugal" preset, or pause.` }, now);
      }
    }

    for (const key of this.warnings.keys()) if (!seen.has(key)) this.warnings.delete(key);
    for (const id of this.readyToStartSince.keys()) if (!this.coord.getTask(id) || this.coord.getTask(id)!.status !== 'queued') this.readyToStartSince.delete(id);
    return this.current();
  }

  /** When today's budget will be used up at the last hour's spending rate, or null if not on track to. */
  projectedBudgetOut(now = Date.now()): number | null {
    const first = this.coord.listProjects()[0];
    const daily = first ? this.coord.configFor(first.id).budget.dailyUsd : null;
    if (daily === null) return null;
    const spent = this.coord.spentToday();
    const hourAgo = now - 3600_000;
    const r = this.coord.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s, MIN(started_at) AS first FROM runs WHERE started_at >= ?').get(hourAgo) as { s: number; first: number | null };
    if (!r.first || r.s <= 0) return null;
    const windowMs = Math.max(10 * 60_000, now - r.first);
    const perMs = r.s / windowMs;
    const remaining = daily - spent;
    if (remaining <= 0) return now;
    const at = now + remaining / perMs;
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return at < midnight.getTime() ? at : null;
  }
}
