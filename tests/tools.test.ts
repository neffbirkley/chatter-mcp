import assert from "node:assert/strict";
import { test } from "node:test";
import { INACTIVITY_TTL_MS, SWEEP_THROTTLE_MS, sweep } from "../src/cleanup.ts";
import { openDb } from "../src/db.ts";
import * as store from "../src/store.ts";

const mem = () => openDb(":memory:");

test("send -> recv roundtrip, cursor advances", () => {
  const db = mem();
  store.open(db, "general", "alice", 1);
  store.send(db, "general", "bob", "hello", 2);
  store.send(db, "general", "bob", "world", 3);

  const first = store.recv(db, "general", "alice");
  assert.deepEqual(
    first.map((m) => m.text),
    ["hello", "world"],
  );

  // Cursor advanced: nothing new on a second read.
  assert.equal(store.recv(db, "general", "alice").length, 0);

  store.send(db, "general", "bob", "again", 4);
  assert.deepEqual(
    store.recv(db, "general", "alice").map((m) => m.text),
    ["again"],
  );
});

test("send auto-creates channel; late joiner gets backlog", () => {
  const db = mem();
  store.send(db, "room", "bob", "before you joined", 1);
  store.open(db, "room", "carol", 2);
  assert.deepEqual(
    store.recv(db, "room", "carol").map((m) => m.text),
    ["before you joined"],
  );
});

test("participants have independent cursors", () => {
  const db = mem();
  store.send(db, "c", "x", "m1", 1);
  store.recv(db, "c", "alice"); // alice drains
  // bob has never read -> still sees it
  assert.equal(store.recv(db, "c", "bob").length, 1);
});

test("list reports per-participant unread counts", () => {
  const db = mem();
  store.send(db, "a", "x", "1", 1);
  store.send(db, "a", "x", "2", 2);
  store.send(db, "b", "x", "1", 3);
  store.recv(db, "a", "alice"); // alice clears channel a

  const summary = Object.fromEntries(store.list(db, "alice").map((c) => [c.channel, c.unread]));
  assert.equal(summary.a, 0);
  assert.equal(summary.b, 1);

  // Unknown participant sees everything as unread.
  const fresh = Object.fromEntries(store.list(db, "new").map((c) => [c.channel, c.unread]));
  assert.equal(fresh.a, 2);
  assert.equal(fresh.b, 1);
});

test("sweep prunes idle channels, keeps active, cascades messages", () => {
  const db = mem();
  const t0 = 1_000_000;
  store.send(db, "stale", "x", "old", t0);
  const now = t0 + INACTIVITY_TTL_MS + 1;
  store.send(db, "fresh", "x", "new", now);

  const deleted = sweep(db, now, { force: true });
  assert.equal(deleted, 1);

  const channels = store.list(db, "anyone").map((c) => c.channel);
  assert.deepEqual(channels, ["fresh"]);
  // Cascade: stale channel's messages are gone.
  assert.equal(store.recv(db, "stale", "anyone").length, 0);
});

test("sweep is throttled unless forced", () => {
  const db = mem();
  store.send(db, "stale", "x", "old", 1);
  const now = 1 + INACTIVITY_TTL_MS + 1;

  // First (forced) sweep records the timestamp.
  sweep(db, now, { force: true });
  // A throttled sweep shortly after is skipped (-1), even with a stale channel.
  store.send(db, "stale", "x", "again", now); // refreshes activity anyway
  const skipped = sweep(db, now + SWEEP_THROTTLE_MS - 1);
  assert.equal(skipped, -1);
});
