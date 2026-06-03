import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "./schema.js";

/** Resolve the mailbox DB path: env override, else `~/.agent-mailbox/db.sqlite`. */
export function resolveDbPath(): string {
  const override = process.env.AGENT_MAILBOX_DB?.trim();
  if (override) return override;
  return join(homedir(), ".agent-mailbox", "db.sqlite");
}

/**
 * Open (creating if needed) the shared mailbox database.
 *
 * The file is the cross-process broker: every agent session spawns its own
 * server process, so all coordination happens through this one file. WAL +
 * busy_timeout are mandatory for correctness under concurrent writers.
 */
export function openDb(path = resolveDbPath()): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  applySchema(db);
  return db;
}
