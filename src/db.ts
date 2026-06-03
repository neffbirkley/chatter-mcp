import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Kysely } from "kysely";
import { NodeSqliteDialect } from "./kysely-node-sqlite.js";
import { applySchema, type DB } from "./schema.js";

export type Database = Kysely<DB>;

/** Resolve the chatter DB path: env override, else `~/.chatter/db.sqlite`. */
export function resolveDbPath(): string {
  const override = process.env.CHATTER_DB?.trim();
  if (override) return override;
  return join(homedir(), ".chatter", "db.sqlite");
}

/**
 * Open (creating if needed) the shared chatter database and wrap it in Kysely.
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
  raw.exec("PRAGMA busy_timeout = 15000");

  // Cold-start can race when several processes first open a brand-new file at
  // once: `PRAGMA journal_mode = WAL` does NOT honor busy_timeout and returns
  // "database is locked" immediately if another connection is active. The setup
  // is idempotent, so retry until one process settles the file and the rest see
  // it. Steady-state contention is handled by busy_timeout, not this loop.
  for (let attempt = 0; ; attempt++) {
    try {
      raw.exec("PRAGMA journal_mode = WAL");
      raw.exec("PRAGMA foreign_keys = ON");
      applySchema(raw);
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= 50 || !/lock|busy/i.test(msg)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }

  return new Kysely<DB>({ dialect: new NodeSqliteDialect(raw) });
}
