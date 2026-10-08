/**
 * `node:sqlite` driver.
 *
 * Node 22.5+ ships SQLite in core, so the local-first database needs **no native
 * dependency** on the TypeScript side. The Rust/Tauri side uses `rusqlite` against the
 * same file and the same migration files, which keeps one schema for both processes.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { MigrationDriver } from "../migrations.js";

/** node:sqlite rejects booleans and `undefined`; normalize at the boundary. */
export type SqlValue = string | number | bigint | null | Uint8Array;

export function toSqlValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return null;
    return value;
  }
  if (typeof value === "string" || typeof value === "bigint") return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

export function bindParams(params: readonly unknown[] | undefined): SqlValue[] {
  return (params ?? []).map(toSqlValue);
}

export function fromSqlBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export interface SqliteDriverOptions {
  /** WAL is the right default for an app that reads while a render writes. */
  readonly journalMode?: "wal" | "delete" | "memory";
  readonly synchronous?: "off" | "normal" | "full";
  readonly busyTimeoutMs?: number;
  /** Set false in tests that want to observe FK violations. */
  readonly foreignKeys?: boolean;
  readonly readonly?: boolean;
}

/**
 * Thin, parameter-safe wrapper over `DatabaseSync` implementing `MigrationDriver`.
 * Statements are cached because the editor issues many identical queries per frame.
 */
export class SqliteDriver implements MigrationDriver {
  readonly database: DatabaseSync;
  #statementCache = new Map<string, StatementSync>();
  #transactionDepth = 0;

  constructor(filename: string, options: SqliteDriverOptions = {}) {
    this.database = new DatabaseSync(filename);
    this.database.exec(`PRAGMA journal_mode = ${options.journalMode ?? "wal"}`);
    this.database.exec(`PRAGMA synchronous = ${options.synchronous ?? "normal"}`);
    this.database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
    this.database.exec(`PRAGMA foreign_keys = ${options.foreignKeys === false ? "OFF" : "ON"}`);
    if (options.readonly) this.database.exec("PRAGMA query_only = ON");
  }

  #statement(sql: string): StatementSync {
    const cached = this.#statementCache.get(sql);
    if (cached) return cached;
    const prepared = this.database.prepare(sql);
    // `exec`-style DDL never goes through prepare, so the cache stays bounded by query shape.
    if (this.#statementCache.size > 512) this.#statementCache.clear();
    this.#statementCache.set(sql, prepared);
    return prepared;
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[] {
    return this.#statement(sql).all(...bindParams(params)) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined {
    return this.#statement(sql).get(...bindParams(params)) as T | undefined;
  }

  run(
    sql: string,
    params?: readonly unknown[],
  ): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.#statement(sql).run(...bindParams(params));
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid as number | bigint,
    };
  }

  /**
   * Nested calls become SAVEPOINTs so that an inner failure rolls back only the inner
   * unit while the outer transaction stays usable.
   */
  transaction<T>(fn: () => T): T {
    const depth = this.#transactionDepth;
    const savepoint = `sp_${depth}`;
    if (depth === 0) this.database.exec("BEGIN IMMEDIATE");
    else this.database.exec(`SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;
    try {
      const result = fn();
      this.#transactionDepth -= 1;
      if (depth === 0) this.database.exec("COMMIT");
      else this.database.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.#transactionDepth -= 1;
      try {
        if (depth === 0) this.database.exec("ROLLBACK");
        else this.database.exec(`ROLLBACK TO ${savepoint}`);
      } catch {
        // A rollback failure must not mask the original error.
      }
      throw error;
    }
  }

  /** Run `PRAGMA integrity_check`; used before packaging a project (PRD §11). */
  integrityCheck(): string {
    const rows = this.all<{ integrity_check: string }>("PRAGMA integrity_check");
    return rows.map((row) => row.integrity_check).join("; ");
  }

  close(): void {
    this.#statementCache.clear();
    this.database.close();
  }
}

/** In-memory database for tests. */
export function openMemoryDatabase(options: SqliteDriverOptions = {}): SqliteDriver {
  return new SqliteDriver(":memory:", { journalMode: "memory", ...options });
}
