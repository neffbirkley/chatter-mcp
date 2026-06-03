import type { DatabaseSync } from "node:sqlite";
import type { ColumnType, Generated } from "kysely";

/** Bump when the DDL below changes in a non-additive way. */
export const SCHEMA_VERSION = 2;

export interface ChannelsTable {
  name: string;
  created_at: number;
  last_activity: number;
}

export interface MessagesTable {
  id: Generated<number>;
  channel: string;
  sender: string;
  text: string;
  ts: number;
}

export interface CursorsTable {
  channel: string;
  participant: string;
  last_seen_id: Generated<number>;
  /** Current lease token for the (channel, participant) name; null if unleased. */
  token: ColumnType<string | null, string | null | undefined, string | null>;
  /** Last activity under the current lease, for staleness/reclaim. */
  last_active: ColumnType<number | null, number | null | undefined, number | null>;
}

export interface MetaTable {
  key: string;
  value: number;
}

export interface DB {
  channels: ChannelsTable;
  messages: MessagesTable;
  cursors: CursorsTable;
  meta: MetaTable;
}

const DDL = `
CREATE TABLE IF NOT EXISTS channels (
  name          TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  last_activity INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS messages (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL REFERENCES channels(name) ON DELETE CASCADE,
  sender  TEXT NOT NULL,
  text    TEXT NOT NULL,
  ts      INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cursors (
  channel      TEXT NOT NULL REFERENCES channels(name) ON DELETE CASCADE,
  participant  TEXT NOT NULL,
  last_seen_id INTEGER NOT NULL DEFAULT 0,
  token        TEXT,
  last_active  INTEGER,
  PRIMARY KEY (channel, participant)
) STRICT;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_msg_channel_id ON messages(channel, id);
`;

/** Add a nullable column to a STRICT table if it does not already exist. */
function ensureColumn(db: DatabaseSync, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

/** Create tables/indexes if absent, migrate older schemas, stamp the version. */
export function applySchema(db: DatabaseSync): void {
  db.exec(DDL);
  // v1 -> v2: lease columns on cursors (no-op on fresh DBs that already have them).
  ensureColumn(db, "cursors", "token", "TEXT");
  ensureColumn(db, "cursors", "last_active", "INTEGER");
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
