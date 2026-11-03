import type { Coordinator } from './coordinator.ts';
import { normalizePattern, scopesOverlap } from './scope.ts';
import { clip, jaccard, shortId, wordSet } from './text.ts';
import type { Task } from './types.ts';

/**
 * Project memory that makes agents better over time. Lessons come from three places:
 *  - a failure that a later attempt fixed (what broke, and what the agent did about it),
 *  - a reviewer's request that the implementer then addressed,
 *  - a person's redirect ("use the existing date helper"), the strongest signal of all.
 * Each lesson is scoped to files. Future briefs for overlapping or similar work include the most relevant ones,
 * and lessons that don't help (the task still needed retries) fade out automatically.
 */

export interface Lesson {
  id: string;
  project_id: string;
  scope: string[];
  text: string;
  source: 'fix' | 'review' | 'you' | 'agent';
  task_id: string | null;
  uses: number;
  wins: number;
  disabled: boolean;
  created_at: number;
}

type Row = Record<string, unknown>;

function toLesson(r: Row): Lesson {
  return { ...(r as unknown as Lesson), scope: JSON.parse(String(r.scope ?? '[]')) as string[], disabled: Boolean(r.disabled) };
}

const SOURCE_WEIGHT: Record<Lesson['source'], number> = { you: 1.6, review: 1.2, fix: 1, agent: 0.9 };

export function addLesson(coord: Coordinator, projectId: string, text: string, source: Lesson['source'], scope: string[], taskId: string | null): Lesson | null {
  const body = clip(text, 600);
  if (body.length < 12) return null;
  const words = wordSet(body);
  // Near-duplicates reinforce the existing lesson instead of piling up.
  for (const l of listLessons(coord, projectId, true)) {
    if (jaccard(wordSet(l.text), words) >= 0.7) {
      coord.db.prepare('UPDATE lessons SET disabled = 0, scope = ? WHERE id = ?').run(JSON.stringify([...new Set([...l.scope, ...scope])]), l.id);
      return { ...l, disabled: false };
    }
  }
  const id = shortId('l');
  coord.db
    .prepare('INSERT INTO lessons (id, project_id, scope, text, source, task_id, words, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, projectId, JSON.stringify(scope.map(normalizePattern)), body, source, taskId, [...words].join(' '), Date.now());
  coord.event(projectId, taskId, 'info', 'lesson.learned', `Learned: ${clip(body, 160)}`);
  return toLesson(coord.db.prepare('SELECT * FROM lessons WHERE id = ?').get(id) as Row);
}

export function listLessons(coord: Coordinator, projectId: string, includeDisabled = false): Lesson[] {
  const rows = coord.db.prepare(`SELECT * FROM lessons WHERE project_id = ? ${includeDisabled ? '' : 'AND disabled = 0'} ORDER BY created_at DESC`).all(projectId) as Row[];
  return rows.map(toLesson);
}

/** The few lessons most relevant to a task: overlapping files count most, similar wording next, track record last. */
export function lessonsFor(coord: Coordinator, task: Task, limit: number): Lesson[] {
  if (limit <= 0) return [];
  const words = wordSet(`${task.title} ${task.prompt}`);
  const scored = listLessons(coord, task.project_id)
    .filter((l) => l.task_id !== task.id || l.source === 'you')
    .map((l) => {
      const fileHit = l.scope.length && task.scope.length && scopesOverlap(l.scope, task.scope).length ? 1 : 0;
      const sim = jaccard(wordSet(l.text), words);
      const track = (l.wins + 1) / (l.uses + 2);
      const own = l.task_id === task.id ? 1 : 0;
      return { l, score: (2 * fileHit + 3 * sim + own * 3) * SOURCE_WEIGHT[l.source] * (0.5 + track) };
    })
    .filter((x) => x.score >= 0.45)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.l);
}

export function markUsed(coord: Coordinator, ids: string[]): void {
  for (const id of ids) coord.db.prepare('UPDATE lessons SET uses = uses + 1, last_used = ? WHERE id = ?').run(Date.now(), id);
}

/**
 * Feedback once a task finishes: lessons that were in the brief of an attempt that passed first time get credit;
 * lessons that keep showing up in struggling tasks are retired.
 */
export function creditLessons(coord: Coordinator, lessonIds: string[], succeededFirstTry: boolean): void {
  for (const id of lessonIds) {
    if (succeededFirstTry) coord.db.prepare('UPDATE lessons SET wins = wins + 1 WHERE id = ?').run(id);
    coord.db.prepare("UPDATE lessons SET disabled = 1 WHERE id = ? AND source != 'you' AND uses >= 6 AND wins * 5 < uses").run(id);
  }
}

/** Turns a fixed failure into a lesson: what went wrong, and what the successful attempt says it did. */
export function lessonFromFix(task: Task, failure: string, fixSummary: string): string | null {
  // Strip our own framing ("Checks failed (`npm test`):") and keep the first meaningful line of the real error.
  const cleaned = failure.replace(/^(?:it failed the same way \d+ times[^.]*\.\s*)?(?:checks failed \(`[^`]*`\):|the agent exited with an error:|after combining with the latest merged work, checks failed \(`[^`]*`\):)\s*/i, '');
  const firstLine = cleaned
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 3);
  if (!firstLine || !fixSummary.trim()) return null;
  const where = task.scope.length ? ` in ${task.scope.slice(0, 3).join(', ')}` : '';
  return `When working${where}, "${clip(firstLine, 160)}" came up. What fixed it: ${clip(fixSummary, 320)}`;
}

export function renderLessons(lessons: Lesson[]): string {
  return lessons.map((l) => `- ${l.source === 'you' ? '(from the project owner) ' : l.source === 'review' ? '(from code review) ' : ''}${l.text}`).join('\n');
}

/** A person's guidance usually applies to the area, not just one file: widen "billing/tax.js" to "billing/**". */
export function widenScope(scope: string[]): string[] {
  const out = new Set<string>();
  for (const p of scope) {
    const n = normalizePattern(p);
    const dir = n.includes('/') ? n.slice(0, n.lastIndexOf('/')).replace(/\/\*\*$/, '') : '';
    out.add(dir && !dir.includes('*') ? `${dir}/**` : n);
  }
  return [...out];
}
