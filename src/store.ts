import type { DatabaseSync } from "node:sqlite";
import { all, get, run } from "./sqlite.js";

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
function touchChannel(db: DatabaseSync, channel: string, now: number): void {
  run(
    db,
    `INSERT INTO channels (name, created_at, last_activity)
     VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET last_activity = excluded.last_activity`,
    channel,
    now,
    now,
  );
}

/** Ensure a channel exists and register a participant's cursor (at 0 if new). */
export function open(db: DatabaseSync, channel: string, participant: string, now: number): void {
  touchChannel(db, channel, now);
  run(
    db,
    `INSERT INTO cursors (channel, participant, last_seen_id)
     VALUES (?, ?, 0)
     ON CONFLICT(channel, participant) DO NOTHING`,
    channel,
    participant,
  );
}

/** Append a message to a channel (auto-creating it) and return its id. */
export function send(
  db: DatabaseSync,
  channel: string,
  sender: string,
  text: string,
  now: number,
): number {
  touchChannel(db, channel, now);
  const info = run(
    db,
    "INSERT INTO messages (channel, sender, text, ts) VALUES (?, ?, ?, ?)",
    channel,
    sender,
    text,
    now,
  );
  return Number(info.lastInsertRowid);
}

/**
 * Return unread messages for a participant (oldest first, capped) and advance
 * the participant's cursor past them. A participant unknown to the channel
 * starts at 0 and receives the available backlog.
 */
export function recv(
  db: DatabaseSync,
  channel: string,
  participant: string,
  limit = 100,
): Message[] {
  const cursor = get<{ last_seen_id: number }>(
    db,
    "SELECT last_seen_id FROM cursors WHERE channel = ? AND participant = ?",
    channel,
    participant,
  );
  const since = cursor?.last_seen_id ?? 0;

  const rows = all<Message>(
    db,
    `SELECT id, channel, sender, text, ts
     FROM messages
     WHERE channel = ? AND id > ?
     ORDER BY id ASC
     LIMIT ?`,
    channel,
    since,
    limit,
  );

  const last = rows.at(-1);
  if (last) {
    run(
      db,
      `INSERT INTO cursors (channel, participant, last_seen_id)
       VALUES (?, ?, ?)
       ON CONFLICT(channel, participant) DO UPDATE SET last_seen_id = excluded.last_seen_id`,
      channel,
      participant,
      last.id,
    );
  }

  return rows;
}

/** List every channel with this participant's unread count. */
export function list(db: DatabaseSync, participant: string): ChannelSummary[] {
  return all<ChannelSummary>(
    db,
    `SELECT c.name AS channel,
            c.last_activity AS lastActivity,
            (SELECT COUNT(*) FROM messages m
               WHERE m.channel = c.name
                 AND m.id > COALESCE(cur.last_seen_id, 0)) AS unread
     FROM channels c
     LEFT JOIN cursors cur
       ON cur.channel = c.name AND cur.participant = ?
     ORDER BY c.last_activity DESC`,
    participant,
  );
}
