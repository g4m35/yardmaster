import type { DatabaseSync } from 'node:sqlite';

/** Shared synchronous write boundary, kept independent of schema/module initialization. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
