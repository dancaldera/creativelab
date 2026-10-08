/**
 * Transactional, checksummed schema migrations.
 *
 * PRD §9/§10: "SQLite with transactional migrations" and "versioned project migrations".
 *
 * The runner is driver-agnostic so that the same migration files and the same
 * `schema_migrations` bookkeeping are used by:
 *   * the TypeScript store (`node:sqlite`, used by tests, the CLI and tooling), and
 *   * the Rust/Tauri store (`rusqlite`), which embeds these same `.sql` files.
 *
 * Each migration runs inside a transaction and records a SHA-256 of its normalized
 * body. If a previously applied migration's file changes, startup fails loudly rather
 * than letting two machines disagree about what version 3 means.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationDriver {
  exec(sql: string): void;
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[];
  run(sql: string, params?: readonly unknown[]): void;
  /** Must run `fn` inside a real DB transaction, rolling back if `fn` throws. */
  transaction<T>(fn: () => T): T;
}

export class MigrationError extends Error {
  readonly version?: number;
  constructor(message: string, version?: number) {
    super(message);
    this.name = "MigrationError";
    this.version = version;
  }
}

const MIGRATION_FILENAME = /^(\d{3,})_([a-z0-9_]+)\.sql$/i;

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

/**
 * Normalize before hashing so that trailing newlines or CRLF checkouts do not look like
 * a schema change.
 */
export function migrationChecksum(sql: string): string {
  const normalized = sql
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function parseMigrationFilename(
  filename: string,
): { version: number; name: string } | undefined {
  const match = MIGRATION_FILENAME.exec(filename);
  if (!match) return undefined;
  return { version: Number.parseInt(match[1]!, 10), name: match[2]! };
}

/** Load and validate every migration in a directory, ordered by version. */
export async function loadMigrationsFromDisk(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory);
  const migrations: Migration[] = [];
  for (const entry of entries) {
    const parsed = parseMigrationFilename(entry);
    if (!parsed) continue;
    const sql = await readFile(join(directory, entry), "utf8");
    migrations.push({ version: parsed.version, name: parsed.name, sql });
  }
  return validateMigrations(migrations);
}

/** Enforce a contiguous 1..N sequence with no duplicates and no empty bodies. */
export function validateMigrations(migrations: readonly Migration[]): Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const seen = new Set<number>();
  sorted.forEach((migration, index) => {
    if (seen.has(migration.version)) {
      throw new MigrationError(
        `Duplicate migration version ${migration.version}`,
        migration.version,
      );
    }
    seen.add(migration.version);
    if (migration.sql.trim().length === 0) {
      throw new MigrationError(`Migration ${migration.version} is empty`, migration.version);
    }
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new MigrationError(
        `Migration versions must be contiguous from 1; expected ${expected} but found ${migration.version}`,
        migration.version,
      );
    }
  });
  return sorted;
}

export function readAppliedMigrations(driver: MigrationDriver): AppliedMigration[] {
  driver.exec(MIGRATIONS_TABLE);
  const rows = driver.all<{ version: number; name: string; checksum: string; applied_at: string }>(
    "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC",
  );
  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

export interface MigrateOptions {
  readonly now?: () => Date;
  /** Called after each migration commits, for progress reporting. */
  readonly onApply?: (migration: Migration, index: number, total: number) => void;
  /** When false (default), a checksum drift on an applied migration is an error. */
  readonly allowChecksumDrift?: boolean;
}

export interface MigrateResult {
  readonly applied: readonly number[];
  readonly alreadyApplied: readonly number[];
  readonly schemaVersion: number;
}

/**
 * Apply every pending migration. Idempotent: running twice applies nothing the second
 * time. Each migration is atomic — a failing statement rolls back that migration only.
 */
export function runMigrations(
  driver: MigrationDriver,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): MigrateResult {
  const now = options.now ?? (() => new Date());
  const ordered = validateMigrations(migrations);
  const applied = readAppliedMigrations(driver);
  const appliedByVersion = new Map(applied.map((migration) => [migration.version, migration]));

  // 1. Verify the already-applied prefix before touching anything.
  for (const migration of ordered) {
    const previous = appliedByVersion.get(migration.version);
    if (!previous) continue;
    const checksum = migrationChecksum(migration.sql);
    if (previous.checksum !== checksum && !options.allowChecksumDrift) {
      throw new MigrationError(
        `Migration ${migration.version} (${previous.name}) has changed since it was applied ` +
          `(recorded ${previous.checksum.slice(0, 12)}, found ${checksum.slice(0, 12)}). ` +
          `Add a new migration instead of editing an applied one.`,
        migration.version,
      );
    }
  }

  // 2. A database may not skip ahead of the code, but it may be older than the code.
  const maxKnown = ordered.at(-1)?.version ?? 0;
  const highestApplied = applied.at(-1)?.version ?? 0;
  if (highestApplied > maxKnown) {
    throw new MigrationError(
      `Database schema is version ${highestApplied} but this build only knows ${maxKnown}; ` +
        `upgrade the application before opening this project.`,
      highestApplied,
    );
  }

  const newlyApplied: number[] = [];
  const alreadyApplied: number[] = [];
  ordered.forEach((migration, index) => {
    if (appliedByVersion.has(migration.version)) {
      alreadyApplied.push(migration.version);
      return;
    }
    try {
      driver.transaction(() => {
        driver.exec(migration.sql);
        driver.run(
          "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
          [
            migration.version,
            migration.name,
            migrationChecksum(migration.sql),
            now().toISOString(),
          ],
        );
      });
    } catch (error) {
      throw new MigrationError(
        `Migration ${migration.version}_${migration.name} failed: ${(error as Error).message}`,
        migration.version,
      );
    }
    newlyApplied.push(migration.version);
    options.onApply?.(migration, index, ordered.length);
  });

  return {
    applied: newlyApplied,
    alreadyApplied,
    schemaVersion: readAppliedMigrations(driver).at(-1)?.version ?? 0,
  };
}

/** Current schema version of a database, or 0 when it has never been migrated. */
export function currentSchemaVersion(driver: MigrationDriver): number {
  return readAppliedMigrations(driver).at(-1)?.version ?? 0;
}
