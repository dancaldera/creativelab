-- 0001_init.sql — initial local-first schema.
--
-- Design rules (PRD §10):
--   * Timeline coordinates are integer frames, never floating-point seconds.
--   * Media assets are immutable; edits create new clips/effects, not new files.
--   * Migrations are transactional and versioned; this file is embedded verbatim by
--     both the TypeScript store (node:sqlite) and the Rust/Tauri store (rusqlite),
--     so it must stay dialect-portable SQLite.

CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  schema_version     INTEGER NOT NULL,
  title              TEXT NOT NULL,
  fps_num            INTEGER NOT NULL,
  fps_den            INTEGER NOT NULL,
  width              INTEGER NOT NULL,
  height             INTEGER NOT NULL,
  color_profile      TEXT NOT NULL DEFAULT 'bt709',
  sample_rate        INTEGER NOT NULL DEFAULT 48000,
  channels           INTEGER NOT NULL DEFAULT 2,
  workspace_rel_path TEXT NOT NULL DEFAULT '.',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  CHECK (fps_num > 0 AND fps_den > 0),
  CHECK (width > 0 AND height > 0)
);

CREATE TABLE IF NOT EXISTS sequences (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  width           INTEGER NOT NULL,
  height          INTEGER NOT NULL,
  fps_num         INTEGER NOT NULL,
  fps_den         INTEGER NOT NULL,
  duration_frames INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (duration_frames >= 0)
);
CREATE INDEX IF NOT EXISTS idx_sequences_project ON sequences(project_id);

CREATE TABLE IF NOT EXISTS assets (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  media_type        TEXT NOT NULL,          -- video | image | audio | subtitle
  storage_mode      TEXT NOT NULL DEFAULT 'copied', -- copied | linked | generated
  uri               TEXT NOT NULL,          -- absolute path or provider URL
  relative_path     TEXT,                   -- project-relative; NULL for linked originals
  sha256            TEXT,
  bytes             INTEGER,
  duration_frames   INTEGER,
  width             INTEGER,
  height            INTEGER,
  sample_rate       INTEGER,
  channels          INTEGER,
  fps_num           INTEGER,
  fps_den           INTEGER,
  codec             TEXT,
  container         TEXT,
  origin            TEXT NOT NULL DEFAULT 'imported', -- imported | generated
  parent_asset_id   TEXT REFERENCES assets(id) ON DELETE SET NULL,
  generation_job_id TEXT,
  prompt_revision_id TEXT,
  probe_json        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  missing_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);
CREATE INDEX IF NOT EXISTS idx_assets_sha ON assets(project_id, sha256);
CREATE INDEX IF NOT EXISTS idx_assets_parent ON assets(parent_asset_id);

CREATE TABLE IF NOT EXISTS tracks (
  id           TEXT PRIMARY KEY,
  sequence_id  TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,               -- video | audio | caption
  name         TEXT NOT NULL,
  sort_order   INTEGER NOT NULL,
  muted        INTEGER NOT NULL DEFAULT 0,
  locked       INTEGER NOT NULL DEFAULT 0,
  hidden       INTEGER NOT NULL DEFAULT 0,
  solo         INTEGER NOT NULL DEFAULT 0,
  volume_db    REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_sequence ON tracks(sequence_id, sort_order);

CREATE TABLE IF NOT EXISTS clips (
  id               TEXT PRIMARY KEY,
  track_id         TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  sequence_id      TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  asset_id         TEXT REFERENCES assets(id) ON DELETE SET NULL,
  label            TEXT NOT NULL DEFAULT '',
  start_frame      INTEGER NOT NULL,
  source_in_frame  INTEGER NOT NULL DEFAULT 0,
  duration_frames  INTEGER NOT NULL,
  speed_num        INTEGER NOT NULL DEFAULT 1,
  speed_den        INTEGER NOT NULL DEFAULT 1,
  properties_json  TEXT NOT NULL DEFAULT '{}',
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK (duration_frames > 0),
  CHECK (speed_num > 0 AND speed_den > 0)
);
CREATE INDEX IF NOT EXISTS idx_clips_track ON clips(track_id, start_frame);
CREATE INDEX IF NOT EXISTS idx_clips_sequence ON clips(sequence_id, start_frame);
CREATE INDEX IF NOT EXISTS idx_clips_asset ON clips(asset_id);

CREATE TABLE IF NOT EXISTS effects (
  id          TEXT PRIMARY KEY,
  clip_id     TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  params_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_effects_clip ON effects(clip_id, sort_order);

CREATE TABLE IF NOT EXISTS keyframes (
  id          TEXT PRIMARY KEY,
  effect_id   TEXT NOT NULL REFERENCES effects(id) ON DELETE CASCADE,
  property    TEXT NOT NULL,
  frame       INTEGER NOT NULL,
  value_json  TEXT NOT NULL,
  easing      TEXT NOT NULL DEFAULT 'linear',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keyframes_effect ON keyframes(effect_id, property, frame);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider_id          TEXT NOT NULL,
  model_id             TEXT NOT NULL,
  mode                 TEXT NOT NULL,
  modality             TEXT NOT NULL,
  status               TEXT NOT NULL,
  idempotency_key      TEXT,
  submission_lock      TEXT,
  request_json         TEXT NOT NULL,
  provider_job_id      TEXT,
  retry_count          INTEGER NOT NULL DEFAULT 0,
  next_poll_at         TEXT,
  progress             REAL,
  cost_estimate_json   TEXT,
  actual_cost_json     TEXT,
  output_asset_ids_json TEXT NOT NULL DEFAULT '[]',
  error_json           TEXT,
  submitted_at         TEXT,
  completed_at         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_project_status ON generation_jobs(project_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency
  ON generation_jobs(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_events (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, created_at);

CREATE TABLE IF NOT EXISTS prompt_revisions (
  id               TEXT PRIMARY KEY,
  job_id           TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
  asset_id         TEXT REFERENCES assets(id) ON DELETE SET NULL,
  prompt           TEXT NOT NULL,
  negative_prompt  TEXT,
  references_json  TEXT NOT NULL DEFAULT '[]',
  seed             INTEGER,
  parameters_json  TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_revisions_job ON prompt_revisions(job_id);

CREATE TABLE IF NOT EXISTS export_jobs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Deliberately *not* a foreign key: the export log is an audit record and must
  -- survive deletion of the sequence it rendered.
  sequence_id     TEXT NOT NULL,
  preset_json     TEXT NOT NULL,
  output_path     TEXT NOT NULL,
  status          TEXT NOT NULL,
  progress        REAL NOT NULL DEFAULT 0,
  rendered_frames INTEGER NOT NULL DEFAULT 0,
  total_frames    INTEGER NOT NULL DEFAULT 0,
  errors_json     TEXT NOT NULL DEFAULT '[]',
  log_path        TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_export_jobs_project ON export_jobs(project_id, created_at);

-- Provider *metadata* only. Secrets live in the OS keychain and are referenced by
-- opaque handle; a plaintext key never reaches this table (PRD §13).
CREATE TABLE IF NOT EXISTS provider_configs (
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES projects(id) ON DELETE CASCADE,
  provider_id       TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  base_url          TEXT,
  credential_ref    TEXT,
  auth_scheme       TEXT NOT NULL DEFAULT 'bearer',
  extra_headers_json TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_configs_scope
  ON provider_configs(provider_id, COALESCE(project_id, ''));

CREATE TABLE IF NOT EXISTS model_catalog (
  id             TEXT PRIMARY KEY,
  provider_id    TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  modality       TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  pricing_json   TEXT,
  fetched_at     TEXT NOT NULL,
  is_stale       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_catalog_unique
  ON model_catalog(provider_id, model_id, modality);

CREATE TABLE IF NOT EXISTS spend_ledger (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  job_id        TEXT REFERENCES generation_jobs(id) ON DELETE SET NULL,
  provider_id   TEXT NOT NULL,
  amount_json   TEXT NOT NULL,
  kind          TEXT NOT NULL,               -- estimate | actual
  day           TEXT NOT NULL,               -- YYYY-MM-DD in local time
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spend_day ON spend_ledger(day);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
