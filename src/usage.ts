import type { AgentEvent } from './adapters/types.ts';

type Usage = Extract<AgentEvent, { type: 'usage' }>;
type Price = { inPerM: number; outPerM: number; cachedInPerM?: number };

/**
 * - actual: every counted usage event carried the CLI's own dollar figure.
 * - estimated: every counted event was priced from the configured list prices.
 * - mixed: some of each; `actualUsd` and `estimatedUsd` say how much.
 * - unknown: the CLI reported no usage at all. `costUsd` is then 0 because nothing was measured, not because the run
 *   was free.
 */
export type CostProvenance = 'actual' | 'estimated' | 'mixed' | 'unknown';

export interface UsageSnapshot {
  /** actualUsd + estimatedUsd for this run (the resume baseline excluded where it is known to be included). */
  costUsd: number;
  actualUsd: number;
  estimatedUsd: number;
  provenance: CostProvenance;
  /** Input tokens including cache reads and writes (the long-standing meaning of `tokensIn`). */
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  /** Null when no event reported cache writes separately (unknown, not zero). */
  cacheWriteTokens: number | null;
  /** Usage events that were counted (repeats of one message id count once). */
  events: number;
  sessionTotalUsd: number;
  /** Plain-language caveats about this figure, e.g. unverified resume semantics. */
  limitations: string[];
}

/**
 * How a CLI's cumulative token-only totals relate to earlier runs of a resumed session. Dollar totals from Claude Code
 * (`total_cost_usd`) are treated as session-wide, as before. For token-only snapshots this is not verified per CLI,
 * so the default is `unknown`: nothing is subtracted and the snapshot carries a limitation.
 */
export type ResumedSnapshotScope = 'session' | 'run' | 'unknown';

interface Part {
  actual: number;
  estimated: number;
  actualEvents: number;
  estimatedEvents: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWriteKnown: boolean;
}

const ZERO: Part = { actual: 0, estimated: 0, actualEvents: 0, estimatedEvents: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, cacheWriteKnown: false };

function plus(a: Part, b: Part, sign = 1): Part {
  return {
    actual: a.actual + sign * b.actual, estimated: a.estimated + sign * b.estimated,
    actualEvents: a.actualEvents + sign * b.actualEvents, estimatedEvents: a.estimatedEvents + sign * b.estimatedEvents,
    tokensIn: a.tokensIn + sign * b.tokensIn, tokensOut: a.tokensOut + sign * b.tokensOut,
    cacheRead: a.cacheRead + sign * b.cacheRead, cacheWrite: a.cacheWrite + sign * b.cacheWrite,
    cacheWriteKnown: a.cacheWriteKnown || b.cacheWriteKnown,
  };
}

function maxPart(a: Part, b: Part): Part {
  return {
    actual: Math.max(a.actual, b.actual), estimated: Math.max(a.estimated, b.estimated),
    actualEvents: b.actualEvents, estimatedEvents: b.estimatedEvents,
    tokensIn: Math.max(a.tokensIn, b.tokensIn), tokensOut: Math.max(a.tokensOut, b.tokensOut),
    cacheRead: Math.max(a.cacheRead, b.cacheRead), cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    cacheWriteKnown: a.cacheWriteKnown || b.cacheWriteKnown,
  };
}

/**
 * Spend for one agent run, from the usage events its CLI prints. Traps it avoids:
 * - Claude Code prints an API message once per content block, each copy carrying the same usage; counting every
 *   copy doubled the mid-run estimate and tripped budgets at about half the real spend. Each message id counts once
 *   (if a later copy reports more tokens, only the growth is added).
 * - A cumulative event is a snapshot of the whole run so far: it replaces the incremental events before it.
 * - A resumed session's final dollar totals include what the earlier runs of that session already spent (`baseline`).
 * - A run that priced some events itself and left others to the list prices keeps both parts (`mixed`), rather than
 *   dropping the estimated part as soon as one real figure arrives.
 */
export class UsageMeter {
  private readonly price: Price;
  private readonly baseline: number;
  private readonly resumedScope: ResumedSnapshotScope;
  private readonly perId = new Map<string, Part>();
  private snap: Part | null = null;
  private inc: Part = ZERO;
  private readonly notes = new Set<string>();

  constructor(price: Price, baselineUsd = 0, opts: { resumedTokenSnapshots?: ResumedSnapshotScope } = {}) {
    this.price = price;
    this.baseline = baselineUsd;
    this.resumedScope = opts.resumedTokenSnapshots ?? 'unknown';
  }

  private priced(tokensIn: number, cachedIn: number, tokensOut: number): number {
    return (tokensIn * this.price.inPerM + cachedIn * (this.price.cachedInPerM ?? this.price.inPerM) + tokensOut * this.price.outPerM) / 1e6;
  }

  private part(ev: Usage, cumulative: boolean): Part {
    const cachedIn = Math.max(0, ev.cachedIn ?? 0);
    const cacheWriteKnown = ev.cacheWriteIn !== undefined;
    const base = {
      tokensIn: ev.tokensIn + cachedIn, tokensOut: ev.tokensOut, cacheRead: cachedIn,
      cacheWrite: Math.max(0, ev.cacheWriteIn ?? 0), cacheWriteKnown,
    };
    if (ev.costUsd !== undefined) {
      const actual = cumulative ? Math.max(0, ev.costUsd - this.baseline) : Math.max(0, ev.costUsd);
      return { ...base, actual, estimated: 0, actualEvents: 1, estimatedEvents: 0 };
    }
    let estimated = this.priced(ev.tokensIn, cachedIn, ev.tokensOut);
    if (cumulative && this.baseline > 0) {
      if (this.resumedScope === 'session') estimated = Math.max(0, estimated - this.baseline);
      else if (this.resumedScope === 'unknown') {
        this.notes.add('Resumed session with a token-only cumulative total: whether it includes earlier runs is not verified for this CLI, so nothing was subtracted and this may overstate the run.');
      }
    }
    return { ...base, actual: 0, estimated, actualEvents: 0, estimatedEvents: 1 };
  }

  add(ev: Usage): void {
    if (ev.cumulative) {
      this.snap = this.part(ev, true);
      this.inc = ZERO;
      if (this.baseline > 0) this.notes.add('Token counts come from a resumed session\'s cumulative total and may include earlier runs.');
      return;
    }
    const p = this.part(ev, false);
    if (!ev.id) {
      this.inc = plus(this.inc, p);
      return;
    }
    const prev = this.perId.get(ev.id);
    const sameKind = prev && prev.actualEvents === p.actualEvents;
    const counted = prev && sameKind ? maxPart(prev, p) : p;
    this.inc = plus(prev ? plus(this.inc, prev, -1) : this.inc, counted);
    this.perId.set(ev.id, counted);
  }

  private get total(): Part {
    return this.snap ? plus(this.snap, this.inc) : this.inc;
  }

  get tokensIn(): number {
    return this.total.tokensIn;
  }

  get tokensOut(): number {
    return this.total.tokensOut;
  }

  get actualUsd(): number {
    return this.total.actual;
  }

  get estimatedUsd(): number {
    return this.total.estimated;
  }

  get provenance(): CostProvenance {
    const t = this.total;
    if (t.actualEvents > 0 && t.estimatedEvents > 0) return 'mixed';
    if (t.actualEvents > 0) return 'actual';
    if (t.estimatedEvents > 0) return 'estimated';
    return 'unknown';
  }

  /** What this run cost: CLI-reported dollars plus list-price estimates for whatever the CLI did not price. */
  get spent(): number {
    const t = this.total;
    return t.actual + t.estimated;
  }

  /** True unless every counted figure came from the CLI itself (mixed and unknown count as estimated). */
  get estimated(): boolean {
    return this.provenance !== 'actual';
  }

  /** The session's running total as the CLI reports it (for the next resume's baseline). */
  get sessionTotal(): number {
    return this.baseline + this.spent;
  }

  snapshot(): UsageSnapshot {
    const t = this.total;
    return {
      costUsd: t.actual + t.estimated, actualUsd: t.actual, estimatedUsd: t.estimated, provenance: this.provenance,
      tokensIn: t.tokensIn, tokensOut: t.tokensOut, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheWriteKnown ? t.cacheWrite : null,
      events: t.actualEvents + t.estimatedEvents, sessionTotalUsd: this.baseline + t.actual + t.estimated, limitations: [...this.notes],
    };
  }
}

/** A snapshot for work that never ran (no reviewer, canceled before launch). */
export function emptyUsage(): UsageSnapshot {
  return { costUsd: 0, actualUsd: 0, estimatedUsd: 0, provenance: 'unknown', tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: null, events: 0, sessionTotalUsd: 0, limitations: [] };
}
