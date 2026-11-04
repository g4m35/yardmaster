import type { AgentEvent } from './adapters/types.ts';

type Usage = Extract<AgentEvent, { type: 'usage' }>;
type Price = { inPerM: number; outPerM: number; cachedInPerM?: number };

/**
 * Spend for one agent run, from the usage events its CLI prints. Two traps it avoids:
 * - Claude Code prints an API message once per content block, each copy carrying the same usage; counting every
 *   copy doubled the mid-run estimate and tripped budgets at about half the real spend. Each message id counts once.
 * - A resumed session's final totals include what the earlier runs of that session already spent (`baseline`).
 */
export class UsageMeter {
  private readonly price: Price;
  private readonly baseline: number;
  private readonly seen = new Set<string>();
  private estimate = 0;
  private actual: number | null = null;
  tokensIn = 0;
  tokensOut = 0;

  constructor(price: Price, baselineUsd = 0) {
    this.price = price;
    this.baseline = baselineUsd;
  }

  private priced(ev: Usage): number {
    return (ev.tokensIn * this.price.inPerM + (ev.cachedIn ?? 0) * (this.price.cachedInPerM ?? this.price.inPerM) + ev.tokensOut * this.price.outPerM) / 1e6;
  }

  add(ev: Usage): void {
    if (ev.cumulative) {
      this.tokensIn = ev.tokensIn + (ev.cachedIn ?? 0);
      this.tokensOut = ev.tokensOut;
      if (ev.costUsd !== undefined) this.actual = Math.max(0, ev.costUsd - this.baseline);
      else this.estimate = this.priced(ev);
      return;
    }
    if (ev.id) {
      if (this.seen.has(ev.id)) return;
      this.seen.add(ev.id);
    }
    this.tokensIn += ev.tokensIn + (ev.cachedIn ?? 0);
    this.tokensOut += ev.tokensOut;
    if (ev.costUsd !== undefined) this.actual = (this.actual ?? 0) + ev.costUsd;
    this.estimate += ev.costUsd ?? this.priced(ev);
  }

  /** What this run cost: the CLI's own figure when it reported one, otherwise the estimate from list prices. */
  get spent(): number {
    return this.actual ?? this.estimate;
  }

  get estimated(): boolean {
    return this.actual === null;
  }

  /** The session's running total as the CLI reports it (for the next resume's baseline). */
  get sessionTotal(): number {
    return this.baseline + this.spent;
  }
}
