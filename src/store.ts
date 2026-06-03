import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "./db.js";

/** A name's lease is reclaimable once idle longer than this. */
export const LEASE_TTL_MS = 2 * 60 * 1000;

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
  | { granted: true; token: string }
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
}

/** A batch of messages plus how many remain unread beyond it. */
export interface Batch {
  messages: Message[];
  remaining: number;
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
    return { granted: true, token };
  });
}

/** Append a message to a channel and return its id. Requires a valid lease token. */
export async function send(
  db: Database,
  channel: string,
  sender: string,
  token: string,
  text: string,
  now: number,
): Promise<number> {
  await refreshLease(db, channel, sender, token, now);
  await touchChannel(db, channel, now);
  const inserted = await db
    .insertInto("messages")
    .values({ channel, sender, text, ts: now })
    .executeTakeFirstOrThrow();
  return Number(inserted.insertId);
}

/** Count messages in a channel with id greater than a cursor. */
async function countAfter(exec: Database, channel: string, afterId: number): Promise<number> {
  const row = await exec
    .selectFrom("messages")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("channel", "=", channel)
    .where("id", ">", afterId)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Read unread messages after a cursor (oldest first, capped), with ISO timestamps. */
async function unreadSince(
  exec: Database,
  channel: string,
  since: number,
  limit: number,
): Promise<Message[]> {
  const rows = await exec
    .selectFrom("messages")
    .select(["id", "channel", "sender", "text", "ts"])
    .where("channel", "=", channel)
    .where("id", ">", since)
    .orderBy("id", "asc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({ ...r, tsIso: new Date(r.ts).toISOString() }));
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
 * Return unread messages for a participant (oldest first, capped) and advance
 * the participant's cursor past them, atomically. Requires a valid lease token.
 * `remaining` reports how many messages are still unread beyond this batch.
 */
export function recv(
  db: Database,
  channel: string,
  participant: string,
  token: string,
  now: number,
  limit = 100,
): Promise<Batch> {
  return db.transaction().execute(async (trx): Promise<Batch> => {
    await refreshLease(trx, channel, participant, token, now);

    const cursor = await trx
      .selectFrom("cursors")
      .select("last_seen_id")
      .where("channel", "=", channel)
      .where("participant", "=", participant)
      .executeTakeFirst();
    const since = cursor?.last_seen_id ?? 0;

    const messages = await unreadSince(trx, channel, since, limit);

    const last = messages.at(-1);
    if (!last) return { messages, remaining: 0 };

    await trx
      .insertInto("cursors")
      .values({ channel, participant, last_seen_id: last.id })
      .onConflict((oc) =>
        oc.columns(["channel", "participant"]).doUpdateSet({ last_seen_id: last.id }),
      )
      .execute();

    return { messages, remaining: await countAfter(trx, channel, last.id) };
  });
}

/**
 * Like recv, but does NOT advance the cursor — preview unread messages without
 * consuming them. Refreshes the lease (peeking keeps your presence alive).
 * Requires a valid lease token.
 */
export async function peek(
  db: Database,
  channel: string,
  participant: string,
  token: string,
  now: number,
  limit = 100,
): Promise<Batch> {
  await refreshLease(db, channel, participant, token, now);

  const cursor = await db
    .selectFrom("cursors")
    .select("last_seen_id")
    .where("channel", "=", channel)
    .where("participant", "=", participant)
    .executeTakeFirst();
  const since = cursor?.last_seen_id ?? 0;

  const messages = await unreadSince(db, channel, since, limit);
  const last = messages.at(-1);
  return { messages, remaining: last ? await countAfter(db, channel, last.id) : 0 };
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
                              WHERE channel = c.name AND participant = ${participant}), 0))`;

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
