import assert from "node:assert/strict";
import { test } from "node:test";
import { INACTIVITY_TTL_MS, SWEEP_THROTTLE_MS, sweep } from "../src/cleanup.ts";
import { type Database, openDb } from "../src/db.ts";
import * as store from "../src/store.ts";
import { LEASE_TTL_MS, LeaseError } from "../src/store.ts";

const mem = () => openDb(":memory:");

/** open and assert a token was granted. */
async function claim(db: Database, channel: string, as: string, now = 1): Promise<string> {
  const r = await store.open(db, channel, as, now);
  assert.ok(r.granted, `expected lease for ${as}`);
  return r.token;
}

test("send -> recv roundtrip, cursor advances", async () => {
  const db = mem();
  const alice = await claim(db, "general", "alice");
  const bob = await claim(db, "general", "bob");
  await store.send(db, "general", "bob", bob, "hello", 2);
  await store.send(db, "general", "bob", bob, "world", 3);

  const first = await store.recv(db, "general", "alice", alice, 4);
  assert.deepEqual(
    first.map((m) => m.text),
    ["hello", "world"],
  );

  // Cursor advanced: nothing new on a second read.
  assert.equal((await store.recv(db, "general", "alice", alice, 5)).length, 0);

  await store.send(db, "general", "bob", bob, "again", 6);
  assert.deepEqual(
    (await store.recv(db, "general", "alice", alice, 7)).map((m) => m.text),
    ["again"],
  );
});

test("late joiner gets backlog", async () => {
  const db = mem();
  const bob = await claim(db, "room", "bob");
  await store.send(db, "room", "bob", bob, "before you joined", 1);
  const carol = await claim(db, "room", "carol", 2);
  assert.deepEqual(
    (await store.recv(db, "room", "carol", carol, 3)).map((m) => m.text),
    ["before you joined"],
  );
});

test("participants have independent cursors", async () => {
  const db = mem();
  const x = await claim(db, "c", "x");
  await store.send(db, "c", "x", x, "m1", 1);
  const alice = await claim(db, "c", "alice", 2);
  const bob = await claim(db, "c", "bob", 3);
  await store.recv(db, "c", "alice", alice, 4); // alice drains
  // bob has never read -> still sees it
  assert.equal((await store.recv(db, "c", "bob", bob, 5)).length, 1);
});

test("list reports discovery fields and per-participant unread", async () => {
  const db = mem();
  const x = await claim(db, "a", "x");
  await store.send(db, "a", "x", x, "1", 1);
  await store.send(db, "a", "x", x, "2", 2);
  const y = await claim(db, "b", "y", 3);
  await store.send(db, "b", "y", y, "1", 3);
  const alice = await claim(db, "a", "alice", 4);
  await store.recv(db, "a", "alice", alice, 5); // alice clears channel a

  const byChannel = new Map((await store.list(db, "alice")).map((c) => [c.channel, c]));
  assert.equal(byChannel.get("a")?.unread, 0);
  assert.equal(byChannel.get("b")?.unread, 1);
  assert.equal(byChannel.get("a")?.messages, 2);
  assert.deepEqual(byChannel.get("a")?.members.sort(), ["alice", "x"]);
  assert.match(byChannel.get("a")?.lastActivityIso ?? "", /^\d{4}-\d\d-\d\dT/);

  // Anonymous discovery omits unread.
  const anon = await store.list(db);
  assert.equal(anon.find((c) => c.channel === "a")?.unread, undefined);
  assert.equal(anon.find((c) => c.channel === "a")?.messages, 2);
});

test("send/recv reject a wrong token", async () => {
  const db = mem();
  await claim(db, "c", "alice");
  await assert.rejects(() => store.send(db, "c", "alice", "not-the-token", "hi", 2), LeaseError);
  await assert.rejects(() => store.recv(db, "c", "alice", "not-the-token", 3), LeaseError);
});

test("open rejects a name with a fresh lease, reclaims a stale one", async () => {
  const db = mem();
  const t0 = 1_000;
  const first = await store.open(db, "c", "alice", t0);
  assert.ok(first.granted);

  // Same name while the lease is fresh -> rejected with a retry hint.
  const dup = await store.open(db, "c", "alice", t0 + 1);
  assert.equal(dup.granted, false);
  if (!dup.granted) assert.ok(dup.retryAfterMs > 0);

  // After the TTL the lease is stale and reclaimable; the old token is revoked.
  const reclaim = await store.open(db, "c", "alice", t0 + LEASE_TTL_MS + 1);
  assert.ok(reclaim.granted);
  if (first.granted) {
    await assert.rejects(
      () => store.send(db, "c", "alice", first.token, "stale", t0 + LEASE_TTL_MS + 2),
      LeaseError,
    );
  }
});

test("reclaim keeps the existing read position", async () => {
  const db = mem();
  const t0 = 1_000;
  const a1 = await claim(db, "c", "alice", t0);
  const bob = await claim(db, "c", "bob", t0);
  await store.send(db, "c", "bob", bob, "m1", t0);
  await store.recv(db, "c", "alice", a1, t0); // alice now caught up

  // alice reconnects after the lease goes stale.
  const a2 = await claim(db, "c", "alice", t0 + LEASE_TTL_MS + 1);
  await store.send(db, "c", "bob", bob, "m2", t0 + LEASE_TTL_MS + 2);
  // Resumes from where she left off — only the new message.
  assert.deepEqual(
    (await store.recv(db, "c", "alice", a2, t0 + LEASE_TTL_MS + 3)).map((m) => m.text),
    ["m2"],
  );
});

test("sweep prunes idle channels, keeps active, cascades messages", async () => {
  const db = mem();
  const t0 = 1_000_000;
  const x = await claim(db, "stale", "x", t0);
  await store.send(db, "stale", "x", x, "old", t0);
  const now = t0 + INACTIVITY_TTL_MS + 1;
  const y = await claim(db, "fresh", "y", now);
  await store.send(db, "fresh", "y", y, "new", now);

  const deleted = await sweep(db, now, { force: true });
  assert.equal(deleted, 1);

  const channels = (await store.list(db)).map((c) => c.channel);
  assert.deepEqual(channels, ["fresh"]);
});

test("sweep is throttled unless forced", async () => {
  const db = mem();
  const x = await claim(db, "stale", "x", 1);
  await store.send(db, "stale", "x", x, "old", 1);
  const now = 1 + INACTIVITY_TTL_MS + 1;

  await sweep(db, now, { force: true });
  const skipped = await sweep(db, now + SWEEP_THROTTLE_MS - 1);
  assert.equal(skipped, -1);
});
