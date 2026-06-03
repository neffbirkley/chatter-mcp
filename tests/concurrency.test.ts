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

const dir = mkdtempSync(join(tmpdir(), "chatter-"));
const writer = fileURLToPath(new URL("./_writer.ts", import.meta.url));
const raceWorker = fileURLToPath(new URL("./_race_worker.ts", import.meta.url));

after(() => rmSync(dir, { recursive: true, force: true }));

function run(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited ${code}`)),
    );
  });
}

test("concurrent writers from separate processes do not collide (WAL + busy_timeout)", async () => {
  const dbPath = join(dir, "writers.sqlite");
  await Promise.all(
    Array.from({ length: WRITERS }, (_, i) => run(writer, [dbPath, `w${i}`, String(PER_WRITER)])),
  );

  const db = openDb(dbPath);
  const summary = (await list(db, "auditor")).find((c) => c.channel === "race");
  assert.ok(summary, "race channel should exist");
  // Every write from every process landed; none lost to SQLITE_BUSY.
  assert.equal(summary.unread, WRITERS * PER_WRITER);
});

test("concurrent recv+send across processes never throws SQLITE_BUSY_SNAPSHOT", async () => {
  // recv is a read-cursor-then-write-cursor transaction. With a deferred BEGIN,
  // concurrent recv across processes throws SQLITE_BUSY_SNAPSHOT (busy_timeout
  // cannot retry a stale snapshot). BEGIN IMMEDIATE serializes the writers.
  const dbPath = join(dir, "recv-race.sqlite");
  const WORKERS = 6;
  const ITERS = 40;

  // Each worker exits 0 only if no recv/send call threw.
  await Promise.all(
    Array.from({ length: WORKERS }, (_, i) => run(raceWorker, [dbPath, `p${i}`, String(ITERS)])),
  );

  const db = openDb(dbPath);
  const summary = (await list(db, "auditor")).find((c) => c.channel === "race");
  assert.ok(summary, "race channel should exist");
  // No write lost to a snapshot conflict.
  assert.equal(summary.unread, WORKERS * ITERS);
});
