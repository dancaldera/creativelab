import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  currentSchemaVersion,
  loadMigrationsFromDisk,
  migrationChecksum,
  MigrationError,
  readAppliedMigrations,
  runMigrations,
  validateMigrations,
  type Migration,
} from "../src/migrations.js";
import { openMemoryDatabase } from "../src/store/node-sqlite.js";
import type { SqliteDriver } from "../src/store/node-sqlite.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

let driver: SqliteDriver;

beforeEach(() => {
  driver = openMemoryDatabase();
});

afterEach(() => {
  try {
    driver.close();
  } catch {
    // Already closed by a test.
  }
});

function tableNames(activeDriver: SqliteDriver): string[] {
  return activeDriver
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((row) => row.name);
}

describe("migration files", () => {
  it("loads the shipped migrations in version order", async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(migrations[0]!.version).toBe(1);
    expect(migrations[0]!.name).toBe("init");
    expect(migrations[0]!.sql).toContain("CREATE TABLE IF NOT EXISTS projects");
    // Versions must be a contiguous 1..N sequence starting at 1.
    expect(migrations.map((migration) => migration.version)).toEqual(
      migrations.map((_, index) => index + 1),
    );
  });

  it("creates every entity the PRD §10 data model names", async () => {
    const [init] = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    for (const table of [
      "projects",
      "sequences",
      "tracks",
      "clips",
      "effects",
      "keyframes",
      "assets",
      "generation_jobs",
      "job_events",
      "prompt_revisions",
      "export_jobs",
      "provider_configs",
      "model_catalog",
      "spend_ledger",
      "app_settings",
    ]) {
      expect(init!.sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });
});

describe("validateMigrations", () => {
  const base = (version: number, sql = "SELECT 1"): Migration => ({
    version,
    name: `m${version}`,
    sql,
  });

  it("rejects duplicate versions", () => {
    expect(() => validateMigrations([base(1), base(1)])).toThrow(MigrationError);
  });

  it("rejects a gap in the sequence", () => {
    expect(() => validateMigrations([base(1), base(3)])).toThrow(/contiguous/i);
    expect(() => validateMigrations([base(2)])).toThrow(/contiguous/i);
  });

  it("rejects an empty migration body", () => {
    expect(() => validateMigrations([base(1, "   \n  ")])).toThrow(/empty/i);
  });

  it("accepts a well-formed chain regardless of input order", () => {
    const sorted = validateMigrations([base(3), base(1), base(2)]);
    expect(sorted.map((migration) => migration.version)).toEqual([1, 2, 3]);
  });
});

describe("migrationChecksum", () => {
  it("is insensitive to line endings and trailing whitespace", () => {
    const lf = "CREATE TABLE t (a INTEGER);\nCREATE TABLE u (b TEXT);\n";
    const crlf = "CREATE TABLE t (a INTEGER);\r\nCREATE TABLE u (b TEXT);\r\n";
    const trailing = "CREATE TABLE t (a INTEGER);   \nCREATE TABLE u (b TEXT);\t\n";
    expect(migrationChecksum(crlf)).toBe(migrationChecksum(lf));
    expect(migrationChecksum(trailing)).toBe(migrationChecksum(lf));
  });

  it("changes when the SQL actually changes", () => {
    expect(migrationChecksum("SELECT 1")).not.toBe(migrationChecksum("SELECT 2"));
  });

  it("is a stable sha256 hex digest", () => {
    expect(migrationChecksum("SELECT 1")).toMatch(/^[0-9a-f]{64}$/);
    expect(migrationChecksum("SELECT 1")).toBe(migrationChecksum("SELECT 1"));
  });
});

describe("runMigrations", () => {
  it("applies the shipped schema to an empty database", async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const result = runMigrations(driver, migrations);

    expect(result.applied).toEqual([1]);
    expect(result.schemaVersion).toBe(1);
    expect(tableNames(driver)).toContain("clips");
    expect(tableNames(driver)).toContain("schema_migrations");
  });

  it("is idempotent — a second run applies nothing", async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    runMigrations(driver, migrations);
    const second = runMigrations(driver, migrations);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual([1]);
    expect(readAppliedMigrations(driver)).toHaveLength(1);
  });

  it("records the version, name, checksum and timestamp of each migration", async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const appliedAt = new Date("2026-02-03T04:05:06.000Z");
    runMigrations(driver, migrations, { now: () => appliedAt });
    const [row] = readAppliedMigrations(driver);

    expect(row).toMatchObject({
      version: 1,
      name: "init",
      checksum: migrationChecksum(migrations[0]!.sql),
      appliedAt: appliedAt.toISOString(),
    });
  });

  it("reports progress for each applied migration", async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    const seen: Array<[number, number, number]> = [];
    runMigrations(driver, migrations, {
      onApply: (migration, index, total) => seen.push([migration.version, index, total]),
    });
    expect(seen).toEqual([[1, 0, 1]]);
  });

  it("refuses to open a database whose applied migration has been edited", async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    runMigrations(driver, migrations);

    const tampered: Migration[] = [
      { ...migrations[0]!, sql: `${migrations[0]!.sql}\n-- sneaky change` },
    ];
    expect(() => runMigrations(driver, tampered)).toThrow(/has changed since it was applied/i);
    expect(() => runMigrations(driver, tampered)).toThrow(MigrationError);
  });

  it("can be told to tolerate checksum drift explicitly", async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    runMigrations(driver, migrations);
    const tampered: Migration[] = [
      { ...migrations[0]!, sql: `${migrations[0]!.sql}\n-- comment only` },
    ];
    expect(() => runMigrations(driver, tampered, { allowChecksumDrift: true })).not.toThrow();
  });

  it("refuses to open a database written by a newer build", async () => {
    const migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
    runMigrations(driver, migrations);
    driver.run(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      [2, "future", "deadbeef", "2026-01-01T00:00:00.000Z"],
    );

    expect(() => runMigrations(driver, migrations)).toThrow(/only knows/i);
    expect(() => runMigrations(driver, migrations)).toThrow(/upgrade the application/i);
  });

  it("rolls back a failing migration and leaves no bookkeeping row", () => {
    const breaking: Migration[] = [
      {
        version: 1,
        name: "breaking",
        sql: "CREATE TABLE good (a INTEGER);\nCREATE TABLE bad (a INTEGER, ;",
      },
    ];
    expect(() => runMigrations(driver, breaking)).toThrow(MigrationError);
    // Both the failed DDL and the schema_migrations row must be gone.
    expect(tableNames(driver)).not.toContain("good");
    expect(readAppliedMigrations(driver)).toHaveLength(0);
    expect(currentSchemaVersion(driver)).toBe(0);
  });

  it("applies a multi-step chain in order", () => {
    const chain: Migration[] = [
      { version: 1, name: "first", sql: "CREATE TABLE a (x INTEGER)" },
      { version: 2, name: "second", sql: "CREATE TABLE b (y INTEGER)" },
      { version: 3, name: "third", sql: "ALTER TABLE b ADD COLUMN z TEXT" },
    ];
    const result = runMigrations(driver, chain);
    expect(result.applied).toEqual([1, 2, 3]);
    expect(currentSchemaVersion(driver)).toBe(3);
    expect(tableNames(driver)).toEqual(expect.arrayContaining(["a", "b"]));
  });
});

describe("currentSchemaVersion", () => {
  it("is zero for an untouched database", () => {
    expect(currentSchemaVersion(driver)).toBe(0);
  });
});
