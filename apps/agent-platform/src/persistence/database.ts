import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// The platform's durable state, in one SQLite file: conversation history and
// tasks. (Workspaces were already files on disk.)
//
// Why SQLite: the platform runs as a single instance, and SQLite is a library,
// not a server. There is no extra container, port or password to manage, the
// whole state is one file to back up, and Node ships it (node:sqlite), so it
// isn't even a dependency. The stores sit behind the ConversationStore and
// TaskStore interfaces; when several instances must share state, Postgres is
// one more implementation of the same two interfaces.
//
// node:sqlite is synchronous. Each call is a small indexed read or write on a
// local file, so it is quicker than handing work to a thread would be; it
// only blocks the event loop for that long.

// Numbered schema changes, applied in order at startup and recorded in
// SQLite's user_version. Never edit one that has shipped: append a new one.
const MIGRATIONS: readonly string[] = [
  // 1: conversation history and tasks.
  `
  CREATE TABLE messages (
    conversation_id TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    message         TEXT NOT NULL,     -- one Message as JSON, including provider raw data
    created_at      TEXT NOT NULL,
    PRIMARY KEY (conversation_id, seq)
  ) WITHOUT ROWID;

  CREATE TABLE tasks (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    status          TEXT NOT NULL,
    task            TEXT NOT NULL,     -- the whole Task as JSON; the columns above are for lookups
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX tasks_by_conversation ON tasks (conversation_id, created_at);
  CREATE INDEX tasks_by_status ON tasks (status);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Opens (creating if needed) the database file and brings its schema up to date. ":memory:" for tests. */
export function openDatabase(file: string): DatabaseSync {
  const onDisk = file !== ":memory:";
  // Conversations can hold anything users and models wrote: keep them private to this user.
  if (onDisk) mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  // Before the WAL file exists: SQLite gives it the database file's permissions.
  if (onDisk) chmodSync(file, 0o600);

  // WAL: a crash or power loss can lose the last commits but never corrupts the
  // file, and reads don't wait for writes. NORMAL sync is the usual pairing.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (current > SCHEMA_VERSION) {
    // Written by newer code. Running older code against it could corrupt it.
    throw new Error(`Database schema version ${current} is newer than this code knows (${SCHEMA_VERSION})`);
  }
  for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version - 1]!);
      db.exec(`PRAGMA user_version = ${version}`);
    });
  }
}

/** Runs `fn` atomically: all of its writes are committed, or none. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
