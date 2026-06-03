import type { Database } from "./db.js";

/** Channels idle longer than this are pruned. */
export const INACTIVITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum gap between sweeps so `send` doesn't churn on every call. */
export const SWEEP_THROTTLE_MS = 60 * 60 * 1000;

const LAST_SWEEP_KEY = "last_sweep";

async function readMeta(db: Database, key: string): Promise<number | undefined> {
  const row = await db.selectFrom("meta").select("value").where("key", "=", key).executeTakeFirst();
  return row?.value;
}

async function writeMeta(db: Database, key: string, value: number): Promise<void> {
  await db
    .insertInto("meta")
    .values({ key, value })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value }))
    .execute();
}

/**
 * Opportunistically prune channels (and, via cascade, their messages and
 * cursors) that have been idle past the TTL. Throttled so it runs at most once
 * per {@link SWEEP_THROTTLE_MS}; pass `force` to bypass the throttle.
 *
 * Returns the number of channels deleted, or -1 if skipped by the throttle.
 */
export async function sweep(
  db: Database,
  now: number,
  { ttlMs = INACTIVITY_TTL_MS, throttleMs = SWEEP_THROTTLE_MS, force = false } = {},
): Promise<number> {
  const last = (await readMeta(db, LAST_SWEEP_KEY)) ?? 0;
  if (!force && now - last < throttleMs) return -1;

  const result = await db
    .deleteFrom("channels")
    .where("last_activity", "<", now - ttlMs)
    .executeTakeFirst();
  await writeMeta(db, LAST_SWEEP_KEY, now);
  return Number(result.numDeletedRows);
}
