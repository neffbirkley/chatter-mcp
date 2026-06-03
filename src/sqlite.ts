import type { DatabaseSync } from "node:sqlite";

/** Bind-parameter values our queries use. */
type Param = string | number | bigint | null;

/**
 * The single type boundary between `node:sqlite`'s untyped row records and our
 * typed domain. Every read goes through here so the rest of the codebase never
 * casts. `node:sqlite` returns `Record<string, SQLOutputValue>`; callers assert
 * the row shape that their SQL guarantees.
 */

/** Run a statement and return all rows as `T`. */
export function all<T>(db: DatabaseSync, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

/** Run a statement and return the first row as `T`, or `undefined`. */
export function get<T>(db: DatabaseSync, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

/** Execute a mutating statement; returns changed-row count and last insert id. */
export function run(
  db: DatabaseSync,
  sql: string,
  ...params: Param[]
): { changes: number | bigint; lastInsertRowid: number | bigint } {
  return db.prepare(sql).run(...params);
}
