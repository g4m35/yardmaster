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
  `
  CREATE INDEX runs_started ON runs(started_at);
  CREATE INDEX runs_task_role ON runs(task_id, role, started_at);
  CREATE INDEX deps_depends ON deps(depends_on);
  CREATE INDEX locks_project ON locks(project_id, lease_until);
  CREATE INDEX events_task ON events(task_id);
  CREATE INDEX tasks_status ON tasks(status, assignee);
  `,
  `
  ALTER TABLE tasks ADD COLUMN agent_session TEXT;
  ALTER TABLE tasks ADD COLUMN session_agent TEXT;
  ALTER TABLE tasks ADD COLUMN session_cost REAL NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN session_at INTEGER;
  ALTER TABLE tasks ADD COLUMN created_tier TEXT;
  ALTER TABLE runs ADD COLUMN phases TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE runs ADD COLUMN resumed INTEGER NOT NULL DEFAULT 0;
  `,
];

export type Db = DatabaseSync;

export function openDb(file = paths.db()): Db {
  const db = new DatabaseSync(file);
  // The busy timeout comes first: switching to WAL needs a lock another process (a hub, a hook) may be holding.
  db.exec('PRAGMA busy_timeout = 5000;');
  enableWal(db);
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

/**
 * WAL mode is stored in the file, so only the first opener ever switches it. SQLite answers that switch with "busy"
 * immediately, without the busy timeout, when other connections are opening the same new file, so retry briefly.
 */
function enableWal(db: Db): void {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10_000;
  for (let attempt = 0; ; attempt++) {
    try {
      // A disk without WAL support answers with another mode; that's fine, the database just works slower.
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (err) {
      if (!/locked|busy/i.test((err as Error).message) || Date.now() > deadline) throw err;
    }
    Atomics.wait(pause, 0, 0, Math.min(200, 20 + attempt * 10));
  }
}

export const SCHEMA_VERSION = MIGRATIONS.length;

function schemaVersion(db: Db): number {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

function newerSchema(version: number): Error {
  return new Error(`This database was upgraded by a newer Yardmaster (schema ${version}; this version knows ${SCHEMA_VERSION}). Update Yardmaster, or point YARDMASTER_HOME at another folder.`);
}

/**
 * Brings the schema up to date. Hubs, workers, the CLI and hooks often open the database at the same moment (first
 * run, or right after an upgrade), so the version is re-read inside the write lock and only one of them migrates.
 */
function migrate(db: Db): void {
  const seen = schemaVersion(db);
  if (seen > SCHEMA_VERSION) throw newerSchema(seen);
  if (seen === SCHEMA_VERSION) return;
  tx(db, () => {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    let version = schemaVersion(db);
    if (version > SCHEMA_VERSION) throw newerSchema(version);
    while (version < SCHEMA_VERSION) {
      db.exec(MIGRATIONS[version]!);
      version++;
    }
    db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version));
  });
}

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
