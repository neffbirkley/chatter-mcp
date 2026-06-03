import type { DatabaseSync } from "node:sqlite";
import { get, run } from "./sqlite.js";

/** Channels idle longer than this are pruned. */
export const INACTIVITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum gap between sweeps so `send` doesn't churn on every call. */
export const SWEEP_THROTTLE_MS = 60 * 60 * 1000;

const LAST_SWEEP_KEY = "last_sweep";

function readMeta(db: DatabaseSync, key: string): number | undefined {
  return get<{ value: number }>(db, "SELECT value FROM meta WHERE key = ?", key)?.value;
}

function writeMeta(db: DatabaseSync, key: string, value: number): void {
  run(
    db,
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}

/**
 * Opportunistically prune channels (and, via cascade, their messages and
 * cursors) that have been idle past the TTL. Throttled so it runs at most once
 * per {@link SWEEP_THROTTLE_MS}; pass `force` to bypass the throttle.
 *
 * Returns the number of channels deleted, or -1 if skipped by the throttle.
 */
export function sweep(
  db: DatabaseSync,
  now: number,
  { ttlMs = INACTIVITY_TTL_MS, throttleMs = SWEEP_THROTTLE_MS, force = false } = {},
): number {
  const last = readMeta(db, LAST_SWEEP_KEY) ?? 0;
  if (!force && now - last < throttleMs) return -1;

  const info = run(db, "DELETE FROM channels WHERE last_activity < ?", now - ttlMs);
  writeMeta(db, LAST_SWEEP_KEY, now);
  return Number(info.changes);
}
