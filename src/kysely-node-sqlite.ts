import type { DatabaseSync } from "node:sqlite";
import {
  type CompiledQuery,
  CompiledQuery as CompiledQueryFactory,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

/**
 * Minimal Kysely dialect for Node's built-in `node:sqlite`.
 *
 * Vendored (rather than depending on a third-party adapter) because the useful
 * part is tiny: reuse Kysely's own SQLite adapter/compiler/introspector and add
 * a thin synchronous driver over `DatabaseSync`. The only type assertions in the
 * codebase live here — the boundary where untyped SQLite rows become typed.
 *
 * A single shared connection is serialized by a promise mutex so Kysely
 * transactions (BEGIN…COMMIT) cannot interleave with other queries.
 */

/** `node:sqlite` bind-parameter values. */
type SqlParam = null | number | bigint | string | NodeJS.ArrayBufferView;

class Mutex {
  #locked = false;
  readonly #waiters: Array<() => void> = [];

  async lock(): Promise<void> {
    if (!this.#locked) {
      this.#locked = true;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  unlock(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#locked = false;
  }
}

class NodeSqliteConnection implements DatabaseConnection {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const stmt = this.#db.prepare(compiled.sql);
    const params = compiled.parameters as SqlParam[];

    // `columns()` is non-empty only for row-returning statements. This detects
    // readers for both builder selects and raw `sql` queries, where the query
    // node kind alone (RawNode) is ambiguous.
    if (stmt.columns().length > 0) {
      return Promise.resolve({ rows: stmt.all(...params) as R[] });
    }

    const { changes, lastInsertRowid } = stmt.run(...params);
    return Promise.resolve({
      rows: [],
      numAffectedRows: BigInt(changes),
      insertId: BigInt(lastInsertRowid),
    });
  }

  // biome-ignore lint/correctness/useYield: contract requires a generator; we don't stream.
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Streaming is not supported by the node:sqlite dialect");
  }
}

class NodeSqliteDriver implements Driver {
  readonly #db: DatabaseSync;
  readonly #mutex = new Mutex();
  #connection?: DatabaseConnection;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  async init(): Promise<void> {
    this.#connection = new NodeSqliteConnection(this.#db);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    await this.#mutex.lock();
    if (!this.#connection) throw new Error("node:sqlite driver not initialized");
    return this.#connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    // IMMEDIATE takes the write lock at BEGIN so `busy_timeout` serializes
    // concurrent read-modify-write transactions across processes. A deferred
    // BEGIN defers the write lock until first write, by which point another
    // writer may have invalidated the snapshot — an unretryable
    // SQLITE_BUSY_SNAPSHOT that `busy_timeout` cannot absorb.
    await connection.executeQuery(CompiledQueryFactory.raw("BEGIN IMMEDIATE"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQueryFactory.raw("COMMIT"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQueryFactory.raw("ROLLBACK"));
  }

  async releaseConnection(): Promise<void> {
    this.#mutex.unlock();
  }

  async destroy(): Promise<void> {
    this.#db.close();
  }
}

export class NodeSqliteDialect implements Dialect {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new NodeSqliteDriver(this.#db);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}
