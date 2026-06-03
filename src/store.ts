import { sql } from "kysely";
import type { Database } from "./db.js";

export interface Message {
  id: number;
  channel: string;
  sender: string;
  text: string;
  ts: number;
}

export interface ChannelSummary {
  channel: string;
  unread: number;
  lastActivity: number;
}

/** Ensure a channel row exists and bump its activity timestamp. */
async function touchChannel(db: Database, channel: string, now: number): Promise<void> {
  await db
    .insertInto("channels")
    .values({ name: channel, created_at: now, last_activity: now })
    .onConflict((oc) => oc.column("name").doUpdateSet({ last_activity: now }))
    .execute();
}

/** Ensure a channel exists and register a participant's cursor (at 0 if new). */
export async function open(
  db: Database,
  channel: string,
  participant: string,
  now: number,
): Promise<void> {
  await touchChannel(db, channel, now);
  await db
    .insertInto("cursors")
    .values({ channel, participant, last_seen_id: 0 })
    .onConflict((oc) => oc.columns(["channel", "participant"]).doNothing())
    .execute();
}

/** Append a message to a channel (auto-creating it) and return its id. */
export async function send(
  db: Database,
  channel: string,
  sender: string,
  text: string,
  now: number,
): Promise<number> {
  await touchChannel(db, channel, now);
  const inserted = await db
    .insertInto("messages")
    .values({ channel, sender, text, ts: now })
    .executeTakeFirstOrThrow();
  return Number(inserted.insertId);
}

/**
 * Return unread messages for a participant (oldest first, capped) and advance
 * the participant's cursor past them, atomically. A participant unknown to the
 * channel starts at 0 and receives the available backlog.
 */
export function recv(
  db: Database,
  channel: string,
  participant: string,
  limit = 100,
): Promise<Message[]> {
  return db.transaction().execute(async (trx) => {
    const cursor = await trx
      .selectFrom("cursors")
      .select("last_seen_id")
      .where("channel", "=", channel)
      .where("participant", "=", participant)
      .executeTakeFirst();
    const since = cursor?.last_seen_id ?? 0;

    const rows = await trx
      .selectFrom("messages")
      .select(["id", "channel", "sender", "text", "ts"])
      .where("channel", "=", channel)
      .where("id", ">", since)
      .orderBy("id", "asc")
      .limit(limit)
      .execute();

    const last = rows.at(-1);
    if (last) {
      await trx
        .insertInto("cursors")
        .values({ channel, participant, last_seen_id: last.id })
        .onConflict((oc) =>
          oc.columns(["channel", "participant"]).doUpdateSet({ last_seen_id: last.id }),
        )
        .execute();
    }

    return rows;
  });
}

/** List every channel with this participant's unread count. */
export async function list(db: Database, participant: string): Promise<ChannelSummary[]> {
  const { rows } = await sql<ChannelSummary>`
    SELECT c.name AS channel,
           c.last_activity AS lastActivity,
           (SELECT COUNT(*) FROM messages m
              WHERE m.channel = c.name
                AND m.id > COALESCE(cur.last_seen_id, 0)) AS unread
    FROM channels c
    LEFT JOIN cursors cur
      ON cur.channel = c.name AND cur.participant = ${participant}
    ORDER BY c.last_activity DESC
  `.execute(db);

  return rows.map((r) => ({ ...r, unread: Number(r.unread) }));
}
