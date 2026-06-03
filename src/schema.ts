import type { DatabaseSync } from "node:sqlite";

/** Bump when the DDL below changes in a non-additive way. */
export const SCHEMA_VERSION = 1;

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
  PRIMARY KEY (channel, participant)
) STRICT;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_msg_channel_id ON messages(channel, id);
`;

/** Create tables/indexes if absent and stamp the schema version. */
export function applySchema(db: DatabaseSync): void {
  db.exec(DDL);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
