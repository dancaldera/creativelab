//! Transactional, checksummed schema migrations.
//!
//! This is the Rust half of `packages/core/src/migrations.ts`. Both halves hash the
//! **same** file — the TypeScript store reads `packages/core/migrations/0001_init.sql`
//! from disk, the Rust store embeds it with `include_str!` — so the checksum algorithm
//! has to be byte-identical. If it were not, opening a database created by the other
//! store would fail the drift check and refuse to open.
//!
//! ## The exact normalization (must not change)
//! 1. `\r\n` -> `\n`
//! 2. `[ \t]+$` removed on every line (multiline, i.e. per line)
//! 3. leading/trailing whitespace of the whole string trimmed
//! 4. SHA-256, lowercase hex
//!
//! `migrationChecksum` is asserted against a hand-written reference in the tests,
//! including the CRLF / trailing-whitespace equivalence requirement.

use regex::Regex;
use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::error::{CommandError, CommandResult};

/// Embedded verbatim — the canonical file, not a copy. Keep the relative path stable:
/// it is the whole reason the two stores agree.
pub const INIT_SQL: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/core/migrations/0001_init.sql"
));

pub const MIGRATIONS_TABLE: &str = "\
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
)";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

/// The complete migration set, ordered by version. Contiguous from 1: adding
/// `0002_x.sql` means appending here *and* appending to `MIGRATIONS` in
/// `packages/core/src/migrations.ts`'s loader directory — never editing 0001.
pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "init",
    sql: INIT_SQL,
}];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedMigration {
    pub version: i64,
    pub name: String,
    pub checksum: String,
    pub applied_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrateResult {
    pub applied: Vec<i64>,
    pub already_applied: Vec<i64>,
    pub schema_version: i64,
}

/// Mirror of `migrationChecksum` in `packages/core/src/migrations.ts`.
pub fn migration_checksum(sql: &str) -> String {
    let lf_normalized = sql.replace("\r\n", "\n");
    // `(?m)` makes `$` match before each `\n`; `[ \t]+` is the same class core uses.
    // `regex` has no `\z`-only anchor issue here: every line, including the last, is
    // covered because `(?m)$` also matches at end-of-text.
    // `(?m)` is required: without it `$` matches only at the very end of the haystack, so a
    // line's trailing spaces before a `\n` would survive and the checksum would not match
    // JavaScript's `/^[ \t]+$/gm` pass in `packages/core/src/migrations.ts`.
    let trailing = Regex::new(r"(?m)[ \t]+$").expect("static regex");
    let stripped = trailing.replace_all(&lf_normalized, "");
    let normalized = stripped.trim();
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    hex::encode(hasher.finalize())
}

/// Create `schema_migrations` (idempotent) and read every applied row.
pub fn read_applied_migrations(connection: &Connection) -> CommandResult<Vec<AppliedMigration>> {
    connection.execute_batch(MIGRATIONS_TABLE)?;
    let mut statement = connection.prepare(
        "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(AppliedMigration {
            version: row.get(0)?,
            name: row.get(1)?,
            checksum: row.get(2)?,
            applied_at: row.get(3)?,
        })
    })?;
    let mut applied = Vec::new();
    for row in rows {
        applied.push(row?);
    }
    Ok(applied)
}

/// Current schema version, or 0 when the database has never been migrated.
pub fn current_schema_version(connection: &Connection) -> CommandResult<i64> {
    let applied = read_applied_migrations(connection)?;
    Ok(applied.last().map(|entry| entry.version).unwrap_or(0))
}

/// Apply every pending migration.
///
/// Refuses to run — loudly — when an already-applied migration's checksum drifted, and
/// refuses when the database is *newer* than this build knows about. Each migration runs
/// inside a transaction together with its `schema_migrations` row, so a failure rolls
/// back that migration only.
pub fn run_migrations(connection: &mut Connection) -> CommandResult<MigrateResult> {
    let applied = read_applied_migrations(connection)?;
    let highest_applied = applied.last().map(|entry| entry.version).unwrap_or(0);
    let max_known = MIGRATIONS.last().map(|entry| entry.version).unwrap_or(0);

    // 1. Verify the already-applied prefix before touching anything.
    for migration in MIGRATIONS {
        let previous = applied
            .iter()
            .find(|entry| entry.version == migration.version);
        let Some(previous) = previous else { continue };
        let checksum = migration_checksum(migration.sql);
        if previous.checksum != checksum {
            return Err(CommandError::io(format!(
                "Migration {version} ({name}) has changed since it was applied \
                 (recorded {recorded}, found {found}). Add a new migration instead of \
                 editing an applied one.",
                version = migration.version,
                name = previous.name,
                recorded = &previous.checksum[..12.min(previous.checksum.len())],
                found = &checksum[..12],
            )));
        }
    }

    // 2. A database may not skip ahead of the code, but it may be older than the code.
    if highest_applied > max_known {
        return Err(CommandError::configuration(format!(
            "Database schema is version {highest_applied} but this build only knows \
             {max_known}; upgrade the application before opening this project."
        )));
    }

    let mut result = MigrateResult {
        already_applied: applied.iter().map(|entry| entry.version).collect(),
        schema_version: highest_applied,
        ..MigrateResult::default()
    };

    for migration in MIGRATIONS {
        if applied
            .iter()
            .any(|entry| entry.version == migration.version)
        {
            continue;
        }
        let checksum = migration_checksum(migration.sql);
        let transaction = connection.transaction()?;
        transaction.execute_batch(migration.sql).map_err(|error| {
            CommandError::io(format!(
                "Migration {}_{} failed: {error}",
                migration.version, migration.name
            ))
        })?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
            rusqlite::params![
                migration.version,
                migration.name,
                checksum,
                now_iso8601()
            ],
        )?;
        transaction.commit()?;
        result.applied.push(migration.version);
        result.schema_version = migration.version;
    }

    Ok(result)
}

/// ISO-8601 UTC with millisecond precision — the same shape as JavaScript's
/// `Date.prototype.toISOString()`, e.g. `2024-01-01T00:00:00.000Z`.
///
/// Formatted component-wise instead of via a `time` format description so the output is
/// exactly 24 characters with exactly three subsecond digits (RFC 3339 would emit
/// `+00:00` instead of `Z` and could drop trailing zeros).
pub fn now_iso8601() -> String {
    iso8601_from(time::OffsetDateTime::now_utc())
}

/// Same formatting, for an arbitrary instant (used by tests and backdated rows).
pub fn iso8601_from(value: time::OffsetDateTime) -> String {
    use time::Month;
    let month: u8 = match value.month() {
        Month::January => 1,
        Month::February => 2,
        Month::March => 3,
        Month::April => 4,
        Month::May => 5,
        Month::June => 6,
        Month::July => 7,
        Month::August => 8,
        Month::September => 9,
        Month::October => 10,
        Month::November => 11,
        Month::December => 12,
    };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.year(),
        month,
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.millisecond()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::OptionalExtension;

    /// The value asserted by reading the file with a hand-written normalization, so a
    /// regression in `migration_checksum` cannot be masked by sharing the same bug.
    #[test]
    fn checksum_matches_a_hand_computed_reference() {
        // Normalize by hand with the simplest possible primitives.
        let manual = |sql: &str| -> String {
            let lf = sql.replace("\r\n", "\n");
            let mut cleaned = String::with_capacity(lf.len());
            for line in lf.split('\n') {
                cleaned.push_str(line.trim_end_matches([' ', '\t']));
                cleaned.push('\n');
            }
            // `split`/`push` round-trip adds no trailing newline beyond the original
            // unless the original ended with one, so trim the whole thing next.
            let trimmed = cleaned.trim();
            let mut hasher = Sha256::new();
            hasher.update(trimmed.as_bytes());
            hex::encode(hasher.finalize())
        };
        assert_eq!(migration_checksum(INIT_SQL), manual(INIT_SQL));
        assert_eq!(migration_checksum(INIT_SQL).len(), 64);
        assert!(migration_checksum(INIT_SQL)
            .chars()
            .all(|c| c.is_ascii_hexdigit()));
    }

    /// The exact requirement: CRLF line endings and trailing spaces/tabs must not change
    /// the checksum, otherwise a Windows checkout would look like a schema change.
    #[test]
    fn crlf_and_trailing_whitespace_normalize_to_the_same_checksum() {
        // Written with explicit `\r` escapes: a literal carriage return in the source file
        // would be normalized away by the lexer and the test would prove nothing.
        let clean = "CREATE TABLE a (id TEXT);\nCREATE TABLE b (id TEXT);\n";
        assert_eq!(
            migration_checksum(clean),
            migration_checksum("CREATE TABLE a (id TEXT);\r\nCREATE TABLE b (id TEXT);\r\n")
        );
        assert_eq!(
            migration_checksum(clean),
            migration_checksum(
                "CREATE TABLE a (id TEXT);   \nCREATE TABLE b (id TEXT);\t\t\n   \n"
            )
        );
        assert_eq!(
            migration_checksum(clean),
            migration_checksum(
                "  \r\n  CREATE TABLE a (id TEXT);\t\r\nCREATE TABLE b (id TEXT);\r\n\r\n"
            )
        );
        // The canonical migration file itself is CRLF-insensitive.
        assert_eq!(
            migration_checksum(INIT_SQL),
            migration_checksum(&INIT_SQL.replace('\n', "\r\n"))
        );
        // Real changes still change the checksum.
        assert_ne!(
            migration_checksum(clean),
            migration_checksum("CREATE TABLE a (id TEXT NOT NULL);\nCREATE TABLE b (id TEXT);\n")
        );
    }

    #[test]
    fn checksum_is_stable_across_runs() {
        let first = migration_checksum(INIT_SQL);
        for _ in 0..8 {
            assert_eq!(migration_checksum(INIT_SQL), first);
        }
        // A fresh read of the same bytes through a different code path must agree.
        let reread = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/core/migrations/0001_init.sql"
        ))
        .expect("the canonical migration file must be readable from this crate");
        assert_eq!(migration_checksum(&reread), first);
        assert_eq!(
            reread, INIT_SQL,
            "include_str! must embed the canonical file verbatim"
        );
    }

    fn memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory sqlite");
        connection
    }

    #[test]
    fn migrations_are_idempotent_and_create_the_schema() {
        let mut connection = memory_connection();
        let first = run_migrations(&mut connection).unwrap();
        assert_eq!(first.applied, vec![1]);
        assert_eq!(first.schema_version, 1);
        assert_eq!(current_schema_version(&connection).unwrap(), 1);

        let second = run_migrations(&mut connection).unwrap();
        assert!(second.applied.is_empty(), "{second:?}");
        assert_eq!(second.already_applied, vec![1]);

        // Spot-check that the canonical tables exist.
        for table in [
            "projects",
            "sequences",
            "tracks",
            "clips",
            "assets",
            "export_jobs",
        ] {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "table {table} was not created");
        }
    }

    #[test]
    fn drifted_checksum_refuses_to_open() {
        let mut connection = memory_connection();
        run_migrations(&mut connection).unwrap();
        connection
            .execute(
                "UPDATE schema_migrations SET checksum = 'deadbeefdeadbeef' WHERE version = 1",
                [],
            )
            .unwrap();
        let error = run_migrations(&mut connection).unwrap_err();
        assert!(
            error.message.contains("has changed since it was applied"),
            "{error}"
        );
    }

    #[test]
    fn a_newer_database_refuses_to_open() {
        let mut connection = memory_connection();
        run_migrations(&mut connection).unwrap();
        connection
            .execute(
                "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', 'x', 'now')",
                [],
            )
            .unwrap();
        let error = run_migrations(&mut connection).unwrap_err();
        assert!(error.message.contains("upgrade the application"), "{error}");
    }

    #[test]
    fn now_iso8601_has_javascript_shape() {
        let value = now_iso8601();
        assert_eq!(value.len(), 24, "{value}");
        assert!(value.ends_with('Z'), "{value}");
        assert_eq!(&value[4..5], "-");
        assert_eq!(&value[10..11], "T");
        assert_eq!(&value[19..20], ".");
        // Round-trips as an RFC 3339 timestamp.
        use time::format_description::well_known::Rfc3339;
        use time::OffsetDateTime;
        OffsetDateTime::parse(&value, &Rfc3339).expect("must parse as RFC 3339");
    }

    #[test]
    fn migrations_table_is_created_even_on_an_empty_database() {
        let connection = memory_connection();
        let applied = read_applied_migrations(&connection).unwrap();
        assert!(applied.is_empty());
        let exists: Option<String> = connection
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(exists.as_deref(), Some("schema_migrations"));
    }
}
