import type { TaskStatus } from './types.ts';

/** Shared authorization fence; caller-supplied statuses never broaden it. */
export const WORKER_ACTIVE_STATUSES: TaskStatus[] = ['running', 'verifying', 'ready'];
export const WORKER_FINALIZE_STATUSES: TaskStatus[] = [...WORKER_ACTIVE_STATUSES, 'canceled', 'needs_human'];
