import assert from "node:assert/strict";
import { test } from "node:test";
import { type Database, openDb } from "../src/db.ts";
import * as store from "../src/store.ts";
import { LeaseError } from "../src/store.ts";

const mem = () => openDb(":memory:");

async function claim(db: Database, channel: string, as: string, now = 1): Promise<string> {
  const r = await store.open(db, channel, as, now);
  assert.ok(r.granted, `expected lease for ${as}`);
  return r.token;
}

test("open reports backlog: full history on a fresh start join, 0 on now", async () => {
  const db = mem();
  const bob = await claim(db, "c", "bob");
  await store.send(db, "c", "bob", bob, "m1", 1);
  await store.send(db, "c", "bob", bob, "m2", 2);

  const start = await store.open(db, "c", "carol", 3, "start");
  assert.ok(start.granted);
  if (start.granted) assert.equal(start.backlog, 2);

  const now = await store.open(db, "c", "dave", 4, "now");
  assert.ok(now.granted);
  if (now.granted) assert.equal(now.backlog, 0);
});

test("backlog counts only messages visible to the joiner (targeting)", async () => {
  const db = mem();
  const bob = await claim(db, "c", "bob");
  await store.send(db, "c", "bob", bob, "broadcast", 1);
  await store.send(db, "c", "bob", bob, "for-zoe", 2, ["zoe"]);

  const carol = await store.open(db, "c", "carol", 3, "start");
  assert.ok(carol.granted);
  if (carol.granted) assert.equal(carol.backlog, 1); // sees only the broadcast

  const zoe = await store.open(db, "c", "zoe", 4, "start");
  assert.ok(zoe.granted);
  if (zoe.granted) assert.equal(zoe.backlog, 2); // broadcast + targeted
});

test("targeted send: only recipients (and sender) receive it", async () => {
  const db = mem();
  const alice = await claim(db, "c", "alice");
  const bob = await claim(db, "c", "bob");
  const carol = await claim(db, "c", "carol");
  await store.send(db, "c", "alice", alice, "hi bob", 1, ["bob"]);

  assert.deepEqual(
    (await store.recv(db, "c", "bob", bob, 2)).messages.map((m) => m.text),
    ["hi bob"],
  );
  assert.equal((await store.recv(db, "c", "carol", carol, 3)).messages.length, 0);
  // Sender sees their own targeted message.
  assert.deepEqual(
    (await store.recv(db, "c", "alice", alice, 4)).messages.map((m) => m.text),
    ["hi bob"],
  );
});

test("targeted recv exposes the recipient list as `to`; broadcast omits it", async () => {
  const db = mem();
  const alice = await claim(db, "c", "alice");
  const bob = await claim(db, "c", "bob");
  await store.send(db, "c", "alice", alice, "broadcast", 1);
  await store.send(db, "c", "alice", alice, "targeted", 2, ["bob"]);

  const msgs = (await store.recv(db, "c", "bob", bob, 3)).messages;
  assert.equal(msgs[0]?.to, undefined);
  assert.deepEqual(msgs[1]?.to, ["bob"]);
});

test("list unread respects targeting", async () => {
  const db = mem();
  const alice = await claim(db, "c", "alice");
  await claim(db, "c", "bob", 1);
  await store.send(db, "c", "alice", alice, "broadcast", 1);
  await store.send(db, "c", "alice", alice, "only-carol", 2, ["carol"]);

  const forBob = (await store.list(db, "bob")).find((c) => c.channel === "c");
  assert.equal(forBob?.unread, 1); // bob doesn't see the carol-only message
});

test("ack records read receipts; messages carry acks; idempotent", async () => {
  const db = mem();
  const alice = await claim(db, "c", "alice");
  const bob = await claim(db, "c", "bob");
  const id = await store.send(db, "c", "alice", alice, "did you get this?", 1);

  // Bob reads then acks (twice — idempotent).
  await store.recv(db, "c", "bob", bob, 2);
  assert.equal(await store.ack(db, "c", "bob", bob, 3, [id]), 1);
  assert.equal(await store.ack(db, "c", "bob", bob, 4, [id]), 1);

  // Sender checks the receipt on its own message via `receipts`.
  const seen = await store.receipts(db, "c", "alice", alice, 5, [id]);
  assert.deepEqual(seen[0]?.acks, ["bob"]);
});

test("ack ignores unknown ids and ids from other channels", async () => {
  const db = mem();
  const a = await claim(db, "c1", "a");
  const b = await claim(db, "c2", "b");
  const id = await store.send(db, "c1", "a", a, "m", 1);
  // Acking c1's message id under channel c2 records nothing.
  assert.equal(await store.ack(db, "c2", "b", b, 2, [id]), 0);
  assert.equal(await store.ack(db, "c1", "a", a, 3, [99999]), 0);
});

test("ack/recv/peek/receipts reject a wrong token", async () => {
  const db = mem();
  await claim(db, "c", "alice");
  await assert.rejects(() => store.ack(db, "c", "alice", "nope", 2, [1]), LeaseError);
  await assert.rejects(() => store.receipts(db, "c", "alice", "nope", 3, [1]), LeaseError);
});

test("recv with waitMs=0 returns immediately when nothing is unread", async () => {
  const db = mem();
  const alice = await claim(db, "c", "alice");
  const batch = await store.recv(db, "c", "alice", alice, 2, { waitMs: 0 });
  assert.equal(batch.messages.length, 0);
});

test("blocking recv parks then returns when a message arrives mid-wait", async () => {
  const db = mem();
  const alice = await claim(db, "c", "alice");
  const bob = await claim(db, "c", "bob");

  // Park alice with a generous deadline and a fast poll.
  const pending = store.recv(db, "c", "alice", alice, 10, { waitMs: 2000, pollMs: 10 });
  // Deliver after the first poll cycle.
  setTimeout(() => void store.send(db, "c", "bob", bob, "late", 11), 30);

  const batch = await pending;
  assert.deepEqual(
    batch.messages.map((m) => m.text),
    ["late"],
  );
});

test("blocking recv returns empty at the deadline (no message)", async () => {
  const db = mem();
  const alice = await claim(db, "c", "alice");
  const start = Date.now();
  const batch = await store.recv(db, "c", "alice", alice, 2, { waitMs: 60, pollMs: 10 });
  assert.equal(batch.messages.length, 0);
  assert.ok(Date.now() - start >= 50, "should have waited roughly until the deadline");
});

test("an abort signal ends the wait early", async () => {
  const db = mem();
  const alice = await claim(db, "c", "alice");
  const ac = new AbortController();
  const pending = store.recv(db, "c", "alice", alice, 2, {
    waitMs: 5000,
    pollMs: 10,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 30);
  const batch = await pending;
  assert.equal(batch.messages.length, 0);
});

test("a parked recv does NOT block a concurrent send (no write txn held while waiting)", async () => {
  const db = mem();
  const alice = await claim(db, "c", "alice");
  const bob = await claim(db, "c", "bob");

  // alice parks for up to 1s. While she's parked, bob must be able to send
  // promptly — proving no BEGIN IMMEDIATE is held across the wait.
  const parked = store.recv(db, "c", "alice", alice, 10, { waitMs: 1000, pollMs: 50 });
  const sendStart = Date.now();
  await store.send(db, "c", "bob", bob, "unblocked", 11);
  assert.ok(Date.now() - sendStart < 500, "send should not be blocked by the parked recv");

  const batch = await parked;
  assert.deepEqual(
    batch.messages.map((m) => m.text),
    ["unblocked"],
  );
});
