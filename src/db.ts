import { DatabaseSync } from 'node:sqlite';
import { paths } from './paths.ts';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL, base_branch TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL,
    fingerprint TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL, agent TEXT, model TEXT, scope TEXT NOT NULL DEFAULT '[]', scope_inferred INTEGER NOT NULL DEFAULT 0,
    verify TEXT, allow_no_changes INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
    budget_usd REAL, cost_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
    assignee TEXT, machine_id TEXT, branch TEXT, worktree TEXT, base_sha TEXT, head_sha TEXT,
    lease_until INTEGER, not_before INTEGER, wait_for TEXT, pending_rebase INTEGER NOT NULL DEFAULT 0, control TEXT,
    summary TEXT, last_error TEXT, retry_note TEXT, error_fp TEXT, same_error_count INTEGER NOT NULL DEFAULT 0,
    conflict_rounds INTEGER NOT NULL DEFAULT 0, attention TEXT, approved INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    started_at INTEGER, finished_at INTEGER, ready_at INTEGER
  );
  CREATE INDEX tasks_project_status ON tasks(project_id, status);
  CREATE TABLE deps (task_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (task_id, depends_on));
  CREATE TABLE locks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, pattern TEXT NOT NULL, holder TEXT NOT NULL,
    reason TEXT, lease_until INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, machine_id TEXT NOT NULL,
    agent TEXT NOT NULL, model TEXT, pid INTEGER, proc_started INTEGER, log_path TEXT, status TEXT NOT NULL,
    stop_reason TEXT, exit_code INTEGER, cost_usd REAL NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0, cost_estimated INTEGER NOT NULL DEFAULT 0, last_activity TEXT,
    touched TEXT NOT NULL DEFAULT '[]', started_at INTEGER NOT NULL, ended_at INTEGER
  );
  CREATE INDEX runs_task ON runs(task_id);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, task_id TEXT, level TEXT NOT NULL,
    kind TEXT NOT NULL, message TEXT NOT NULL, data TEXT, ts INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
    task_id TEXT, body TEXT NOT NULL, ts INTEGER NOT NULL
  );
  CREATE TABLE message_reads (message_id INTEGER NOT NULL, reader TEXT NOT NULL, PRIMARY KEY (message_id, reader));
  CREATE TABLE machines (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, info TEXT NOT NULL DEFAULT '{}', last_seen INTEGER NOT NULL, is_hub INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT, project_id TEXT, cwd TEXT, machine_id TEXT, last_seen INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE tasks ADD COLUMN review TEXT;
  ALTER TABLE tasks ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN race_group TEXT;
  ALTER TABLE tasks ADD COLUMN guidance TEXT;
  ALTER TABLE tasks ADD COLUMN needs_approval INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN policies TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE runs ADD COLUMN role TEXT NOT NULL DEFAULT 'implement';
  ALTER TABLE runs ADD COLUMN tier TEXT;
  ALTER TABLE runs ADD COLUMN lessons TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE runs ADD COLUMN verdict TEXT;
  CREATE TABLE lessons (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '[]', text TEXT NOT NULL,
    source TEXT NOT NULL, task_id TEXT, words TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_used INTEGER
  );
  CREATE INDEX lessons_project ON lessons(project_id);
  `,
];

export type Db = DatabaseSync;

export function openDb(file = paths.db()): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  let version = row ? Number(row.value) : 0;
  while (version < MIGRATIONS.length) {
    tx(db, () => {
      db.exec(MIGRATIONS[version]!);
      version++;
      db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version));
    });
  }
}

/** Write transaction that also serializes against other processes sharing the database file. */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
