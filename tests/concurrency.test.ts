import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { list } from "../src/store.ts";

const WRITERS = 4;
const PER_WRITER = 50;

const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-"));
const dbPath = join(dir, "race.sqlite");
const writer = fileURLToPath(new URL("./_writer.ts", import.meta.url));

after(() => rmSync(dir, { recursive: true, force: true }));

function runWriter(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", writer, dbPath, name, String(PER_WRITER)],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)),
    );
  });
}

test("concurrent writers from separate processes do not collide (WAL + busy_timeout)", async () => {
  await Promise.all(Array.from({ length: WRITERS }, (_, i) => runWriter(`w${i}`)));

  const db = openDb(dbPath);
  const summary = list(db, "auditor").find((c) => c.channel === "race");
  assert.ok(summary, "race channel should exist");
  // Every write from every process landed; none lost to SQLITE_BUSY.
  assert.equal(summary.unread, WRITERS * PER_WRITER);
});
