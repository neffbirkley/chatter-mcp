import { randomUUID } from "node:crypto";
import { type SqlBool, sql } from "kysely";
import type { Database } from "./db.js";

/** A name's lease is reclaimable once idle longer than this. */
export const LEASE_TTL_MS = 2 * 60 * 1000;

/** How long a blocking recv/peek parks waiting for a message, by default. */
export const DEFAULT_WAIT_MS = 25_000;
/** Hard cap on a blocking wait — kept under the typical 60s MCP client timeout. */
export const MAX_WAIT_MS = 55_000;
/** How often a parked recv/peek re-checks for new messages. */
export const POLL_INTERVAL_MS = 300;

/** Thrown when a send/recv presents a token that does not hold the name's lease. */
export class LeaseError extends Error {
  constructor(channel: string, participant: string) {
    super(
      `No valid lease for '${participant}' in '${channel}'. Call open to claim this name and get a fresh token.`,
    );
    this.name = "LeaseError";
  }
}

export type OpenResult =
  | { granted: true; token: string; backlog: number }
  | { granted: false; retryAfterMs: number };

/** Where a brand-new participant starts reading. */
export type From = "start" | "now";

export interface Message {
  id: number;
  channel: string;
  sender: string;
  text: string;
  ts: number;
  tsIso: string;
  /** Targeted recipients; absent for a broadcast message. */
  to?: string[];
  /** Participants who have acked this message (read receipts). */
  acks: string[];
}

/** A batch of messages plus how many remain unread beyond it. */
export interface Batch {
  messages: Message[];
  remaining: number;
}

/** Options controlling a (possibly blocking) read. */
export interface ReadOptions {
  /** Max messages to return in one batch. */
  limit?: number;
  /** Park up to this many ms waiting for a message when none are unread (0 = return immediately). */
  waitMs?: number;
  /** How often to re-check while parked. */
  pollMs?: number;
  /** Abort the wait early (e.g. client disconnect). */
  signal?: AbortSignal;
  /** Wall clock for the wait deadline; injectable for tests. */
  clock?: () => number;
  /** Delay primitive for the wait loop; injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Real-time delay that resolves early on abort and never keeps the event loop alive. */
function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export interface ChannelSummary {
  channel: string;
  /** Everyone who has participated: union of message senders and readers. */
  members: string[];
  /** Total messages in the channel. */
  messages: number;
  lastActivity: number;
  lastActivityIso: string;
  /** This participant's unread count — present only when `as` was supplied. */
  unread?: number;
}

/**
 * SQL predicate: is a message visible to `viewer`? A message is visible when it
 * is a broadcast (`recipients IS NULL`), the viewer sent it, or the viewer is in
 * its recipient list. `table` qualifies the column so the predicate works inside
 * aliased subqueries (e.g. `messages m`).
 */
function visibleTo(viewer: string, table = "messages") {
  const t = sql.raw(table);
  return sql<SqlBool>`(${t}.recipients IS NULL OR ${t}.sender = ${viewer} OR EXISTS (SELECT 1 FROM json_each(${t}.recipients) WHERE value = ${viewer}))`;
}

/** Ensure a channel row exists and bump its activity timestamp. */
async function touchChannel(db: Database, channel: string, now: number): Promise<void> {
  await db
    .insertInto("channels")
    .values({ name: channel, created_at: now, last_activity: now })
    .onConflict((oc) => oc.column("name").doUpdateSet({ last_activity: now }))
    .execute();
}

/**
 * Validate and refresh a name's lease in one atomic UPDATE. Throws LeaseError
 * if the token does not match the current lease for (channel, participant).
 */
async function refreshLease(
  exec: Database,
  channel: string,
  participant: string,
  token: string,
  now: number,
): Promise<void> {
  const res = await exec
    .updateTable("cursors")
    .set({ last_active: now })
    .where("channel", "=", channel)
    .where("participant", "=", participant)
    .where("token", "=", token)
    .executeTakeFirst();
  if (Number(res.numUpdatedRows) === 0) throw new LeaseError(channel, participant);
}

/**
 * Claim a name in a channel and return a lease token. Rejects if the name holds
 * a lease that is still fresh (active within {@link LEASE_TTL_MS}); a stale
 * lease (idle past the TTL, e.g. after a crash) is reclaimable and keeps the
 * existing read position. Serialized in a transaction so two concurrent opens
 * for the same name cannot both be granted.
 */
export function open(
  db: Database,
  channel: string,
  participant: string,
  now: number,
  from: From = "start",
): Promise<OpenResult> {
  return db.transaction().execute(async (trx): Promise<OpenResult> => {
    await touchChannel(trx, channel, now);
    const row = await trx
      .selectFrom("cursors")
      .select(["token", "last_active"])
      .where("channel", "=", channel)
      .where("participant", "=", participant)
      .executeTakeFirst();

    if (row?.token != null && row.last_active != null && now - row.last_active < LEASE_TTL_MS) {
      return { granted: false, retryAfterMs: LEASE_TTL_MS - (now - row.last_active) };
    }

    // A brand-new participant may skip the backlog ("now"); a reclaim keeps its
    // existing read position (the onConflict path leaves last_seen_id untouched).
    let initial = 0;
    if (row === undefined && from === "now") {
      const top = await trx
        .selectFrom("messages")
        .select((eb) => eb.fn.max("id").as("maxId"))
        .where("channel", "=", channel)
        .executeTakeFirst();
      initial = Number(top?.maxId ?? 0);
    }

    const token = randomUUID();
    await trx
      .insertInto("cursors")
      .values({ channel, participant, last_seen_id: initial, token, last_active: now })
      .onConflict((oc) =>
        oc.columns(["channel", "participant"]).doUpdateSet({ token, last_active: now }),
      )
      .execute();

    // Backlog: how many messages this participant has not yet seen at open time
    // (full history on a fresh from:'start' join, remaining unread on reclaim,
    // 0 on from:'now'). Surfaced so a joiner always knows what's waiting.
    const cur = await trx
      .selectFrom("cursors")
      .select("last_seen_id")
      .where("channel", "=", channel)
      .where("participant", "=", participant)
      .executeTakeFirst();
    const backlog = await countAfter(trx, channel, cur?.last_seen_id ?? 0, participant);
    return { granted: true, token, backlog };
  });
}

/**
 * Append a message to a channel and return its id. Requires a valid lease token.
 * Pass `recipients` to target specific participants; omit (or empty) to broadcast.
 */
export async function send(
  db: Database,
  channel: string,
  sender: string,
  token: string,
  text: string,
  now: number,
  recipients?: string[],
): Promise<number> {
  await refreshLease(db, channel, sender, token, now);
  await touchChannel(db, channel, now);
  const to = recipients && recipients.length > 0 ? JSON.stringify(recipients) : null;
  const inserted = await db
    .insertInto("messages")
    .values({ channel, sender, text, ts: now, recipients: to })
    .executeTakeFirstOrThrow();
  return Number(inserted.insertId);
}

/**
 * Count messages in a channel with id greater than a cursor. When `viewer` is
 * supplied, only messages visible to that participant are counted.
 */
async function countAfter(
  exec: Database,
  channel: string,
  afterId: number,
  viewer?: string,
): Promise<number> {
  let q = exec
    .selectFrom("messages")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("channel", "=", channel)
    .where("id", ">", afterId);
  if (viewer !== undefined) q = q.where(visibleTo(viewer));
  const row = await q.executeTakeFirst();
  return Number(row?.n ?? 0);
}

interface MessageRow {
  id: number;
  channel: string;
  sender: string;
  text: string;
  ts: number;
  recipients: string | null;
}

/** Shape a raw message row into a Message (ISO timestamp, parsed recipients, empty acks). */
function toMessage(r: MessageRow): Message {
  const msg: Message = {
    id: r.id,
    channel: r.channel,
    sender: r.sender,
    text: r.text,
    ts: r.ts,
    tsIso: new Date(r.ts).toISOString(),
    acks: [],
  };
  if (r.recipients != null) msg.to = JSON.parse(r.recipients) as string[];
  return msg;
}

/**
 * Read unread messages after a cursor that are visible to `viewer` (oldest
 * first, capped), with ISO timestamps and parsed recipients.
 */
async function unreadSince(
  exec: Database,
  channel: string,
  since: number,
  limit: number,
  viewer: string,
): Promise<Message[]> {
  const rows = await exec
    .selectFrom("messages")
    .select(["id", "channel", "sender", "text", "ts", "recipients"])
    .where("channel", "=", channel)
    .where("id", ">", since)
    .where(visibleTo(viewer))
    .orderBy("id", "asc")
    .limit(limit)
    .execute();
  return rows.map(toMessage);
}

/** Attach the set of participants who have acked each message (read receipts). */
async function attachAcks(db: Database, channel: string, messages: Message[]): Promise<void> {
  if (messages.length === 0) return;
  const rows = await db
    .selectFrom("acks")
    .select(["message_id", "participant"])
    .where("channel", "=", channel)
    .where(
      "message_id",
      "in",
      messages.map((m) => m.id),
    )
    .execute();
  const byId = new Map<number, string[]>();
  for (const r of rows) {
    const list = byId.get(r.message_id);
    if (list) list.push(r.participant);
    else byId.set(r.message_id, [r.participant]);
  }
  for (const m of messages) m.acks = byId.get(m.id) ?? [];
}

/** Count participants in a channel other than the given sender. */
export async function listenerCount(
  db: Database,
  channel: string,
  sender: string,
): Promise<number> {
  const row = await db
    .selectFrom("cursors")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("channel", "=", channel)
    .where("participant", "!=", sender)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/**
 * One non-blocking read attempt. Reads unread messages visible to the
 * participant (oldest first, capped) and, when `advance` is set, moves the
 * cursor past them — all in one transaction so concurrent reads don't
 * interleave. Returns the batch with read receipts attached.
 */
function readOnce(
  db: Database,
  channel: string,
  participant: string,
  limit: number,
  advance: boolean,
): Promise<Batch> {
  return db.transaction().execute(async (trx): Promise<Batch> => {
    const cursor = await trx
      .selectFrom("cursors")
      .select("last_seen_id")
      .where("channel", "=", channel)
      .where("participant", "=", participant)
      .executeTakeFirst();
    const since = cursor?.last_seen_id ?? 0;

    const messages = await unreadSince(trx, channel, since, limit, participant);
    const last = messages.at(-1);
    if (!last) return { messages, remaining: 0 };

    if (advance) {
      await trx
        .insertInto("cursors")
        .values({ channel, participant, last_seen_id: last.id })
        .onConflict((oc) =>
          oc.columns(["channel", "participant"]).doUpdateSet({ last_seen_id: last.id }),
        )
        .execute();
    }

    await attachAcks(trx, channel, messages);
    return { messages, remaining: await countAfter(trx, channel, last.id, participant) };
  });
}

/**
 * Block until at least one message is available or the deadline passes, polling
 * between attempts. CRITICAL: no write transaction is held across the wait — a
 * long park must not lock out other writers. The lease is validated once up
 * front (a bad token throws immediately, never parks) and a wait stays well
 * under {@link LEASE_TTL_MS}, so presence survives without mid-wait writes.
 */
async function readWaiting(
  db: Database,
  channel: string,
  participant: string,
  limit: number,
  advance: boolean,
  opts: ReadOptions,
): Promise<Batch> {
  const { waitMs = 0, pollMs = POLL_INTERVAL_MS, signal, clock = Date.now, sleep = sleepMs } = opts;
  const deadline = clock() + Math.min(Math.max(0, waitMs), MAX_WAIT_MS);

  for (;;) {
    const batch = await readOnce(db, channel, participant, limit, advance);
    if (batch.messages.length > 0 || signal?.aborted || clock() >= deadline) return batch;
    await sleep(Math.min(pollMs, Math.max(0, deadline - clock())), signal);
  }
}

/**
 * Return unread messages for a participant (oldest first, capped) and advance
 * the participant's cursor past them, atomically. Requires a valid lease token.
 * `remaining` reports how many messages are still unread beyond this batch.
 *
 * With `waitMs > 0`, parks up to that long for a message instead of returning an
 * empty batch — the long-poll that lets agents wait on a reply without busy-polling.
 */
export async function recv(
  db: Database,
  channel: string,
  participant: string,
  token: string,
  now: number,
  opts: ReadOptions = {},
): Promise<Batch> {
  await refreshLease(db, channel, participant, token, now);
  return readWaiting(db, channel, participant, opts.limit ?? 100, true, opts);
}

/**
 * Like recv, but does NOT advance the cursor — preview unread messages without
 * consuming them. Refreshes the lease (peeking keeps your presence alive).
 * Requires a valid lease token. Supports the same `waitMs` long-poll as recv.
 */
export async function peek(
  db: Database,
  channel: string,
  participant: string,
  token: string,
  now: number,
  opts: ReadOptions = {},
): Promise<Batch> {
  await refreshLease(db, channel, participant, token, now);
  return readWaiting(db, channel, participant, opts.limit ?? 100, false, opts);
}

/**
 * Fetch specific messages by id (regardless of cursor position) with their read
 * receipts attached. This is how a sender checks whether messages it posted have
 * been acked. Restricted to messages in `channel`; unknown ids are dropped.
 * Requires a valid lease token.
 */
export async function receipts(
  db: Database,
  channel: string,
  participant: string,
  token: string,
  now: number,
  ids: number[],
): Promise<Message[]> {
  await refreshLease(db, channel, participant, token, now);
  if (ids.length === 0) return [];
  const rows = await db
    .selectFrom("messages")
    .select(["id", "channel", "sender", "text", "ts", "recipients"])
    .where("channel", "=", channel)
    .where("id", "in", ids)
    .orderBy("id", "asc")
    .execute();
  const messages = rows.map(toMessage);
  await attachAcks(db, channel, messages);
  return messages;
}

/**
 * Record that a participant has read (acked) the given messages — explicit read
 * receipts the sender can observe. Idempotent; unknown ids and ids from other
 * channels are ignored. Returns how many valid messages were acked. Requires a
 * valid lease token.
 */
export async function ack(
  db: Database,
  channel: string,
  participant: string,
  token: string,
  now: number,
  ids: number[],
): Promise<number> {
  await refreshLease(db, channel, participant, token, now);
  if (ids.length === 0) return 0;
  const valid = await db
    .selectFrom("messages")
    .select("id")
    .where("channel", "=", channel)
    .where("id", "in", ids)
    .execute();
  if (valid.length === 0) return 0;
  await db
    .insertInto("acks")
    .values(valid.map((v) => ({ message_id: v.id, channel, participant, ts: now })))
    .onConflict((oc) => oc.columns(["message_id", "participant"]).doNothing())
    .execute();
  return valid.length;
}

/**
 * Discovery: every channel with its members, message count, and last activity,
 * most recently active first. Supply `participant` to also get their unread
 * count per channel; omit it for anonymous discovery.
 */
export async function list(db: Database, participant?: string): Promise<ChannelSummary[]> {
  const unread =
    participant === undefined
      ? sql<number | null>`NULL`
      : sql<number>`(SELECT COUNT(*) FROM messages m
                       WHERE m.channel = c.name
                         AND m.id > COALESCE(
                           (SELECT last_seen_id FROM cursors
                              WHERE channel = c.name AND participant = ${participant}), 0)
                         AND (m.recipients IS NULL OR m.sender = ${participant}
                              OR EXISTS (SELECT 1 FROM json_each(m.recipients) WHERE value = ${participant})))`;

  const channels = await sql<{
    channel: string;
    lastActivity: number;
    messages: number;
    unread: number | null;
  }>`
    SELECT c.name AS channel,
           c.last_activity AS lastActivity,
           (SELECT COUNT(*) FROM messages m WHERE m.channel = c.name) AS messages,
           ${unread} AS unread
    FROM channels c
    ORDER BY c.last_activity DESC
  `.execute(db);

  // Member roster derived from senders + readers. Fetched separately (not via
  // group_concat) because participant names are free text and may contain commas.
  const memberRows = await sql<{ channel: string; name: string }>`
    SELECT channel, name FROM (
      SELECT channel, sender AS name FROM messages
      UNION
      SELECT channel, participant AS name FROM cursors
    ) ORDER BY name
  `.execute(db);

  const members = new Map<string, string[]>();
  for (const { channel, name } of memberRows.rows) {
    const roster = members.get(channel);
    if (roster) roster.push(name);
    else members.set(channel, [name]);
  }

  return channels.rows.map((r) => ({
    channel: r.channel,
    members: members.get(r.channel) ?? [],
    messages: Number(r.messages),
    lastActivity: r.lastActivity,
    lastActivityIso: new Date(r.lastActivity).toISOString(),
    ...(participant === undefined ? {} : { unread: Number(r.unread ?? 0) }),
  }));
}
