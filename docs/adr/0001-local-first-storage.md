# ADR 0001 — SQLite as the working store, `project.json` as the portable manifest

- **Status:** accepted
- **Date:** 2026-10-07
- **Requirements:** PRD §9 (Data), §10 (Data model), §11 (Local project filesystem), FR-01, FR-02

## Context

The studio must open, edit and save a project with hundreds of clips and thousands of
assets, survive a crash mid-save, and remain _owned_ by the user — reopenable years later
without any service we operate. PRD §9 asks for "SQLite with transactional migrations",
and PRD §11 asks for a `project.json` manifest that uses project-relative references and
supports a "Package Project" export.

Those two requirements pull in different directions: SQLite gives atomicity and fast
partial reads; a JSON manifest gives human-readable portability and diffability. A single
store cannot be both.

## Decision

Keep **both**, with clearly separated roles.

- `project.db` (SQLite) is the **working store**: the transactional home of the timeline,
  asset index, job queue, spend ledger and settings. All writes go through it.
- `project.json` is the **portable manifest**: a complete, human-readable snapshot of the
  project, sequences, tracks, clips, effects, keyframes and assets, written atomically on
  every save and used to rehydrate a project when the database is absent.

Both are written from the same in-memory `EditorDocument` in `ProjectSession.save()`, so
they cannot disagree about what the project contains.

Migrations live in `packages/core/migrations/*.sql` and are **shared verbatim** by the
TypeScript store (`node:sqlite`) and the Rust host (`rusqlite`), with an identical
normalization for the recorded SHA-256 checksum. The checksum check is what stops two
builds from silently disagreeing about what "schema version 1" means.

## Consequences

- A packaged project opens on a machine that has never seen the database: `open()` catches
  the empty-database case, reads the manifest, and rebuilds SQLite from it.
- Save cost is a full timeline replace inside one transaction. This is cheap at the target
  scale (a few hundred clips is single-digit milliseconds) and, more importantly, cannot
  leave a half-updated timeline. Autosave is debounced (PRD §14), so it is paid rarely.
- Assets are **upserted, never deleted**, by `saveDocument`. A background generation job can
  commit an asset while the in-memory document is stale; deleting "missing" rows on save
  would destroy that work. Removal is explicit.
- `export_jobs.sequence_id` is deliberately _not_ a foreign key, so the render log is a
  durable audit record that survives sequence deletion.
- Two artifacts can drift if a bug writes one and not the other. Mitigated by writing both
  from one function, and by an atomic temp-file-plus-rename for the manifest so a crash
  leaves either the old or the new file, never a truncated one.

## Alternatives considered

- **A single JSON document as the only store.** Rejected: no transactional write, no
  indexed queries, and rewriting a multi-megabyte file on every autosave is both slow and
  the exact failure mode PRD §14 warns about.
- **SQLite only, no manifest.** Rejected: it contradicts PRD §11, makes the project opaque
  to the user, and makes `Package Project` a database-copy rather than a portable export.
- **A hosted database or embedded server.** Rejected by the executive summary: "No cloud
  account, hosted database, or mandatory backend is required for core editing."
- **`better-sqlite3` / `sql.js` in the renderer.** Rejected: a native build complicates
  packaging, and a WebAssembly SQLite in the webview duplicates the Rust store. Node's
  built-in `node:sqlite` removes the dependency entirely.
