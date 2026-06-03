import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Kysely } from "kysely";
import { NodeSqliteDialect } from "./kysely-node-sqlite.js";
import { applySchema, type DB } from "./schema.js";

export type Database = Kysely<DB>;

/** Resolve the mailbox DB path: env override, else `~/.agent-mailbox/db.sqlite`. */
export function resolveDbPath(): string {
  const override = process.env.AGENT_MAILBOX_DB?.trim();
  if (override) return override;
  return join(homedir(), ".agent-mailbox", "db.sqlite");
}

/**
 * Open (creating if needed) the shared mailbox database and wrap it in Kysely.
 *
 * The file is the cross-process broker: every agent session spawns its own
 * server process, so all coordination happens through this one file. WAL +
 * busy_timeout are mandatory for correctness under concurrent writers.
 */
export function openDb(path = resolveDbPath()): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec("PRAGMA foreign_keys = ON");
  applySchema(raw);

  return new Kysely<DB>({ dialect: new NodeSqliteDialect(raw) });
}
