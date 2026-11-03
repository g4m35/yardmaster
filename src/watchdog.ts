import type { AgentEvent } from './adapters/types.ts';
import type { Config } from './config.ts';
import { canonicalJson, errorFingerprint, sha1 } from './text.ts';

export type VerdictKind = 'loop' | 'oscillation' | 'repeated_error' | 'stall' | 'awaiting_input' | 'timeout';

export interface Verdict {
  kind: VerdictKind;
  /** Plain-language explanation for the user. */
  message: string;
}

const QUESTION = /(\?\s*$)|\b(should i|do you want|would you like|please confirm|let me know|waiting for (your )?(input|approval|confirmation)|approve|permission to)\b/i;

/**
 * Deterministic supervision. No model is consulted, so watching a fleet costs zero tokens:
 * this is the main difference from orchestrators that run an LLM "deacon" to kick stalled agents.
 */
export class Watchdog {
  private readonly cfg: Config['watchdog'];
  private readonly startedAt: number;
  private lastEventAt: number;
  private calls: string[] = [];
  private consecutive = 0;
  private lastCall = '';
  private toolErrors = new Map<string, number>();
  private lastText = '';
  private lastTextAt = 0;
  private sawToolSinceText = false;
  private readonly labels = new Map<string, string>();

  constructor(cfg: Config['watchdog'], now = Date.now()) {
    this.cfg = cfg;
    this.startedAt = now;
    this.lastEventAt = now;
  }

  feed(ev: AgentEvent, now = Date.now()): Verdict | null {
    this.lastEventAt = now;
    if (ev.type === 'tool') {
      const fp = sha1(`${ev.name}:${canonicalJson(ev.input)}`).slice(0, 12);
      this.labels.set(fp, `${ev.name} ${canonicalJson(ev.input).slice(0, 80)}`);
      this.consecutive = fp === this.lastCall ? this.consecutive + 1 : 1;
      this.lastCall = fp;
      this.calls.push(fp);
      if (this.calls.length > 60) this.calls.shift();
      this.sawToolSinceText = true;
      if (this.consecutive >= this.cfg.repeatThreshold) {
        return { kind: 'loop', message: `The agent repeated the same action ${this.consecutive} times in a row (${this.labels.get(fp)}). It looks stuck, so it was stopped before wasting more budget.` };
      }
      const cycle = this.detectCycle();
      if (cycle) return cycle;
    } else if (ev.type === 'tool_result' && !ev.ok) {
      const fp = errorFingerprint(ev.text);
      const n = (this.toolErrors.get(fp) ?? 0) + 1;
      this.toolErrors.set(fp, n);
      if (n >= this.cfg.sameToolErrorLimit) {
        const hint = /permission|denied|not allowed|requires approval/i.test(ev.text)
          ? ' It seems to need a permission it does not have. Allow the command in the agent settings, or set autonomy to "full" for this agent.'
          : '';
        return { kind: 'repeated_error', message: `The agent hit the same error ${n} times: "${ev.text.trim().split('\n')[0]?.slice(0, 140)}".${hint}` };
      }
    } else if (ev.type === 'text') {
      this.lastText = ev.text;
      this.lastTextAt = now;
      this.sawToolSinceText = false;
    }
    return null;
  }

  /** Called on a timer; catches failures that produce no events at all. */
  tick(now = Date.now()): Verdict | null {
    const runtime = now - this.startedAt;
    if (runtime > this.cfg.maxRuntimeMinutes * 60_000) {
      return { kind: 'timeout', message: `The agent ran longer than the ${this.cfg.maxRuntimeMinutes}-minute limit.` };
    }
    const idle = now - this.lastEventAt;
    if (!this.sawToolSinceText && this.lastTextAt && QUESTION.test(this.lastText.trim().slice(-300)) && idle > this.cfg.awaitingInputMinutes * 60_000) {
      return { kind: 'awaiting_input', message: `The agent stopped to ask a question: "${this.lastText.trim().slice(-200)}". Answer it by adding details to the task and retrying.` };
    }
    if (idle > this.cfg.stallMinutes * 60_000) {
      return { kind: 'stall', message: `The agent has been silent for ${Math.round(idle / 60_000)} minutes.` };
    }
    return null;
  }

  /** A-B-A-B (or A-B-C-A-B-C) with no new actions in between. */
  private detectCycle(): Verdict | null {
    const need = this.cfg.oscillationCycles;
    for (const period of [2, 3]) {
      const span = period * need;
      if (this.calls.length < span) continue;
      const recent = this.calls.slice(-span);
      const pattern = recent.slice(0, period);
      if (new Set(pattern).size !== period) continue;
      if (recent.every((c, i) => c === pattern[i % period])) {
        const steps = pattern.map((p) => this.labels.get(p) ?? p).join(' -> ');
        return { kind: 'oscillation', message: `The agent is going back and forth between the same ${period} actions (${steps}) without making progress.` };
      }
    }
    return null;
  }
}
