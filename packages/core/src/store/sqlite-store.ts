/**
 * SQLite-backed `ProjectStore` (node:sqlite).
 *
 * ## Save strategy
 * `saveDocument` replaces the timeline tables (`sequences`/`tracks`/`clips`/`effects`/
 * `keyframes`) wholesale inside one transaction. Clip and track ids are stable, so this
 * is a logical upsert from the app's perspective, but a delete-and-reinsert cannot
 * leave the database half-updated the way a per-row diff can. Autosave is debounced
 * (§14), so the cost is paid at most a few times per second.
 *
 * Assets are **upserted, never deleted**, because background generation jobs and the
 * media prober write assets directly while the in-memory document may still be stale.
 * Removal is explicit via `deleteAsset`.
 */
import type {
  Asset,
  Clip,
  EditorDocument,
  Effect,
  ExportJob,
  GenerationJob,
  JobStatus,
  Keyframe,
  Project,
  PromptRevision,
  ProviderConfig,
  Sequence,
  Spend,
  Track,
} from "../schema.js";
import {
  AssetSchema,
  ClipSchema,
  EffectSchema,
  ExportJobSchema,
  ExportPresetSchema,
  GenerationJobSchema,
  KeyframeSchema,
  ProjectSchema,
  PromptRevisionSchema,
  ProviderConfigSchema,
  SequenceSchema,
  TrackSchema,
  SCHEMA_VERSION,
} from "../schema.js";
import { newId } from "../ids.js";
import { ConfigurationError } from "../errors.js";
import type { AppliedMigration, Migration } from "../migrations.js";
import type { BudgetLedgerEntry } from "../budget.js";
import { currentSchemaVersion, readAppliedMigrations, runMigrations } from "../migrations.js";
import { createInitialDocument, isoNow } from "../timeline.js";
import type {
  CreateProjectInput,
  JobEvent,
  ModelCatalogEntry,
  ProjectStore,
  ProviderConfigInput,
  SaveResult,
} from "./types.js";
import {
  SqliteDriver,
  fromSqlBool,
  parseJsonColumn,
  type SqliteDriverOptions,
} from "./node-sqlite.js";

type Row = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}
function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
function json<T>(value: unknown, fallback: T): T {
  return parseJsonColumn<T>(value, fallback);
}

export interface SqliteProjectStoreOptions extends SqliteDriverOptions {
  /** Path to the SQLite file, or `:memory:`. */
  readonly filename: string;
  /** Migrations to apply on `init()`. Defaults to none (caller supplies them). */
  readonly migrations?: readonly Migration[];
}

export class SqliteProjectStore implements ProjectStore {
  readonly driver: SqliteDriver;
  #migrations: readonly Migration[];
  #projectId: string | null = null;

  constructor(options: SqliteProjectStoreOptions) {
    this.driver = new SqliteDriver(options.filename, options);
    this.#migrations = options.migrations ?? [];
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async init(migrations?: readonly Migration[]): Promise<readonly AppliedMigration[]> {
    const list = migrations ?? this.#migrations;
    if (list.length > 0) runMigrations(this.driver, list);
    return readAppliedMigrations(this.driver);
  }

  async schemaVersion(): Promise<number> {
    return currentSchemaVersion(this.driver);
  }

  async close(): Promise<void> {
    this.driver.close();
  }

  /** The single project row this database file holds. */
  #requireProjectId(): string {
    if (this.#projectId) return this.#projectId;
    const row = this.driver.get<Row>("SELECT id FROM projects ORDER BY created_at ASC LIMIT 1");
    if (!row)
      throw new ConfigurationError("This workspace has no project; create or open one first");
    this.#projectId = str(row["id"]);
    return this.#projectId;
  }

  // -------------------------------------------------------------------------
  // Project
  // -------------------------------------------------------------------------

  async createProject(input: CreateProjectInput): Promise<EditorDocument> {
    const now = input.createdAt ?? isoNow();
    const project = ProjectSchema.parse({
      id: input.id ?? newId("project"),
      schemaVersion: SCHEMA_VERSION,
      title: input.title,
      fps: input.fps,
      width: input.width,
      height: input.height,
      colorProfile: input.colorProfile ?? "bt709",
      sampleRate: input.sampleRate ?? 48_000,
      channels: input.channels ?? 2,
      workspaceRelPath: ".",
      createdAt: now,
      updatedAt: now,
    });

    this.driver.transaction(() => {
      this.driver.run(
        `INSERT INTO projects (id, schema_version, title, fps_num, fps_den, width, height,
                               color_profile, sample_rate, channels, workspace_rel_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          project.id,
          project.schemaVersion,
          project.title,
          project.fps.num,
          project.fps.den,
          project.width,
          project.height,
          project.colorProfile,
          project.sampleRate,
          project.channels,
          project.workspaceRelPath,
          project.createdAt,
          project.updatedAt,
        ],
      );
      const document = createInitialDocument(project);
      this.#writeTimeline(document, now);
    });

    this.#projectId = project.id;
    return this.loadDocument();
  }

  async renameProject(title: string): Promise<void> {
    const id = this.#requireProjectId();
    this.driver.run("UPDATE projects SET title = ?, updated_at = ? WHERE id = ?", [
      title,
      isoNow(),
      id,
    ]);
  }

  async listProjects(): Promise<Array<{ id: string; title: string; updatedAt: string }>> {
    return this.driver
      .all<Row>("SELECT id, title, updated_at FROM projects ORDER BY updated_at DESC")
      .map((row) => ({
        id: str(row["id"]),
        title: str(row["title"]),
        updatedAt: str(row["updated_at"]),
      }));
  }

  async loadDocument(): Promise<EditorDocument> {
    const projectId = this.#requireProjectId();
    const projectRow = this.driver.get<Row>("SELECT * FROM projects WHERE id = ?", [projectId]);
    if (!projectRow) throw new ConfigurationError(`Project ${projectId} disappeared`);

    const project: Project = ProjectSchema.parse({
      id: str(projectRow["id"]),
      schemaVersion: num(projectRow["schema_version"]),
      title: str(projectRow["title"]),
      fps: { num: num(projectRow["fps_num"]), den: num(projectRow["fps_den"]) },
      width: num(projectRow["width"]),
      height: num(projectRow["height"]),
      colorProfile: str(projectRow["color_profile"]),
      sampleRate: num(projectRow["sample_rate"]),
      channels: num(projectRow["channels"]),
      workspaceRelPath: str(projectRow["workspace_rel_path"]),
      createdAt: str(projectRow["created_at"]),
      updatedAt: str(projectRow["updated_at"]),
    });

    const sequences = this.driver
      .all<Row>("SELECT * FROM sequences WHERE project_id = ? ORDER BY created_at ASC", [projectId])
      .map((row): Sequence =>
        SequenceSchema.parse({
          id: str(row["id"]),
          projectId: str(row["project_id"]),
          name: str(row["name"]),
          width: num(row["width"]),
          height: num(row["height"]),
          fps: { num: num(row["fps_num"]), den: num(row["fps_den"]) },
          durationFrames: num(row["duration_frames"]),
          isActive: fromSqlBool(row["is_active"]),
          createdAt: str(row["created_at"]),
          updatedAt: str(row["updated_at"]),
        }),
      );

    const tracks = this.driver
      .all<Row>(
        "SELECT * FROM tracks WHERE sequence_id IN (SELECT id FROM sequences WHERE project_id = ?) ORDER BY sort_order ASC",
        [projectId],
      )
      .map((row): Track =>
        TrackSchema.parse({
          id: str(row["id"]),
          sequenceId: str(row["sequence_id"]),
          kind: str(row["kind"]),
          name: str(row["name"]),
          sortOrder: num(row["sort_order"]),
          muted: fromSqlBool(row["muted"]),
          locked: fromSqlBool(row["locked"]),
          hidden: fromSqlBool(row["hidden"]),
          solo: fromSqlBool(row["solo"]),
          volumeDb: num(row["volume_db"]),
          createdAt: str(row["created_at"]),
          updatedAt: str(row["updated_at"]),
        }),
      );

    const clips = this.driver
      .all<Row>(
        "SELECT * FROM clips WHERE sequence_id IN (SELECT id FROM sequences WHERE project_id = ?) ORDER BY start_frame ASC",
        [projectId],
      )
      .map((row): Clip => {
        const properties = json<Record<string, unknown>>(row["properties_json"], {});
        // `speed_num`/`speed_den` are the queryable mirror of `properties.speed`; the
        // JSON column is canonical, so seed it from the columns when absent.
        if (properties["speed"] === undefined) {
          properties["speed"] = {
            num: num(row["speed_num"]) || 1,
            den: num(row["speed_den"]) || 1,
          };
        }
        return ClipSchema.parse({
          id: str(row["id"]),
          trackId: str(row["track_id"]),
          sequenceId: str(row["sequence_id"]),
          assetId: strOrNull(row["asset_id"]),
          label: str(row["label"]),
          startFrame: num(row["start_frame"]),
          sourceInFrame: num(row["source_in_frame"]),
          durationFrames: num(row["duration_frames"]),
          properties,
          version: num(row["version"]),
          createdAt: str(row["created_at"]),
          updatedAt: str(row["updated_at"]),
        });
      });

    const effects = this.driver
      .all<Row>(
        `SELECT e.* FROM effects e JOIN clips c ON c.id = e.clip_id
         WHERE c.sequence_id IN (SELECT id FROM sequences WHERE project_id = ?) ORDER BY e.sort_order ASC`,
        [projectId],
      )
      .map((row): Effect =>
        EffectSchema.parse({
          id: str(row["id"]),
          clipId: str(row["clip_id"]),
          kind: str(row["kind"]),
          sortOrder: num(row["sort_order"]),
          enabled: fromSqlBool(row["enabled"]),
          params: json(row["params_json"], {}),
          createdAt: str(row["created_at"]),
          updatedAt: str(row["updated_at"]),
        }),
      );

    const keyframes = this.driver
      .all<Row>(
        `SELECT k.* FROM keyframes k JOIN effects e ON e.id = k.effect_id JOIN clips c ON c.id = e.clip_id
         WHERE c.sequence_id IN (SELECT id FROM sequences WHERE project_id = ?) ORDER BY k.frame ASC`,
        [projectId],
      )
      .map((row): Keyframe =>
        KeyframeSchema.parse({
          id: str(row["id"]),
          effectId: str(row["effect_id"]),
          property: str(row["property"]),
          frame: num(row["frame"]),
          value: json(row["value_json"], 0),
          easing: str(row["easing"]),
          createdAt: str(row["created_at"]),
        }),
      );

    const assets = await this.listAssets();

    return { project, sequences, tracks, clips, effects, keyframes, assets };
  }

  async saveDocument(document: EditorDocument): Promise<SaveResult> {
    const projectId = document.project.id;
    const now = isoNow();
    this.driver.transaction(() => {
      this.driver.run(
        `UPDATE projects SET title = ?, fps_num = ?, fps_den = ?, width = ?, height = ?, color_profile = ?,
                             sample_rate = ?, channels = ?, schema_version = ?, updated_at = ?
         WHERE id = ?`,
        [
          document.project.title,
          document.project.fps.num,
          document.project.fps.den,
          document.project.width,
          document.project.height,
          document.project.colorProfile,
          document.project.sampleRate,
          document.project.channels,
          document.project.schemaVersion,
          now,
          projectId,
        ],
      );
      this.#writeTimeline(document, now);
    });
    this.#projectId = projectId;

    return {
      savedAt: now,
      schemaVersion: document.project.schemaVersion,
      clips: document.clips.length,
      tracks: document.tracks.length,
    };
  }

  /**
   * Replace timeline rows for this project. Order matters: `effects` and `keyframes`
   * cascade from `clips`, and `clips` cascade from `tracks`.
   */
  #writeTimeline(document: EditorDocument, now: string): void {
    const projectId = document.project.id;
    const sequenceIds = document.sequences.map((sequence) => sequence.id);

    // Assets come FIRST. `clips.asset_id` is a foreign key, and a project reopened from
    // `project.json` into a fresh database has no asset rows yet — inserting clips first
    // fails the constraint.
    //
    // Assets are upserted rather than replaced, so a stale in-memory document can never
    // delete media that a background generation job just committed.
    //
    // Two passes, because `assets.parent_asset_id` is a *self*-reference: a generated
    // variant may be listed before the original it derives from, and the manifest's
    // ordering must not decide whether the project can be saved. Pass one writes every
    // row with the link cleared; pass two wires the provenance graph now that every
    // referenced row exists.
    for (const asset of document.assets) {
      this.#upsertAsset({ ...asset, parentAssetId: null }, now);
    }
    for (const asset of document.assets) {
      if (asset.parentAssetId !== null) this.#upsertAsset(asset, now);
    }

    this.driver.run(
      `DELETE FROM keyframes WHERE effect_id IN (
         SELECT e.id FROM effects e JOIN clips c ON c.id = e.clip_id
         WHERE c.sequence_id IN (SELECT id FROM sequences WHERE project_id = ?))`,
      [projectId],
    );
    this.driver.run(
      `DELETE FROM effects WHERE clip_id IN (
         SELECT id FROM clips WHERE sequence_id IN (SELECT id FROM sequences WHERE project_id = ?))`,
      [projectId],
    );
    this.driver.run(
      "DELETE FROM clips WHERE sequence_id IN (SELECT id FROM sequences WHERE project_id = ?)",
      [projectId],
    );
    this.driver.run(
      "DELETE FROM tracks WHERE sequence_id IN (SELECT id FROM sequences WHERE project_id = ?)",
      [projectId],
    );
    // Safe to replace sequences wholesale because `export_jobs.sequence_id` is an audit
    // reference without a foreign key, so render history survives sequence deletion.
    this.driver.run("DELETE FROM sequences WHERE project_id = ?", [projectId]);

    for (const sequence of document.sequences) {
      this.driver.run(
        `INSERT INTO sequences (id, project_id, name, width, height, fps_num, fps_den, duration_frames,
                                is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sequence.id,
          projectId,
          sequence.name,
          sequence.width,
          sequence.height,
          sequence.fps.num,
          sequence.fps.den,
          sequence.durationFrames,
          sequence.isActive ? 1 : 0,
          sequence.createdAt,
          now,
        ],
      );
    }

    for (const track of document.tracks) {
      if (!sequenceIds.includes(track.sequenceId)) continue;
      this.driver.run(
        `INSERT INTO tracks (id, sequence_id, kind, name, sort_order, muted, locked, hidden, solo, volume_db,
                             created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          track.id,
          track.sequenceId,
          track.kind,
          track.name,
          track.sortOrder,
          track.muted ? 1 : 0,
          track.locked ? 1 : 0,
          track.hidden ? 1 : 0,
          track.solo ? 1 : 0,
          track.volumeDb,
          track.createdAt,
          now,
        ],
      );
    }

    for (const clip of document.clips) {
      if (!sequenceIds.includes(clip.sequenceId)) continue;
      this.driver.run(
        `INSERT INTO clips (id, track_id, sequence_id, asset_id, label, start_frame, source_in_frame,
                            duration_frames, speed_num, speed_den, properties_json, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          clip.id,
          clip.trackId,
          clip.sequenceId,
          clip.assetId,
          clip.label,
          clip.startFrame,
          clip.sourceInFrame,
          clip.durationFrames,
          clip.properties.speed.num,
          clip.properties.speed.den,
          JSON.stringify(clip.properties),
          clip.version,
          clip.createdAt,
          now,
        ],
      );
    }

    for (const effect of document.effects) {
      this.driver.run(
        `INSERT INTO effects (id, clip_id, kind, sort_order, enabled, params_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          effect.id,
          effect.clipId,
          effect.kind,
          effect.sortOrder,
          effect.enabled ? 1 : 0,
          JSON.stringify(effect.params),
          effect.createdAt,
          now,
        ],
      );
    }

    for (const keyframe of document.keyframes) {
      this.driver.run(
        `INSERT INTO keyframes (id, effect_id, property, frame, value_json, easing, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          keyframe.id,
          keyframe.effectId,
          keyframe.property,
          keyframe.frame,
          JSON.stringify(keyframe.value),
          keyframe.easing,
          keyframe.createdAt,
        ],
      );
    }
  }

  // -------------------------------------------------------------------------
  // Assets
  // -------------------------------------------------------------------------

  #upsertAsset(asset: Asset, now: string): void {
    this.driver.run(
      `INSERT INTO assets (id, project_id, media_type, storage_mode, uri, relative_path, sha256, bytes,
                           duration_frames, width, height, sample_rate, channels, fps_num, fps_den, codec,
                           container, origin, parent_asset_id, generation_job_id, prompt_revision_id,
                           probe_json, created_at, updated_at, missing_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         media_type = excluded.media_type, storage_mode = excluded.storage_mode, uri = excluded.uri,
         relative_path = excluded.relative_path, sha256 = excluded.sha256, bytes = excluded.bytes,
         duration_frames = excluded.duration_frames, width = excluded.width, height = excluded.height,
         sample_rate = excluded.sample_rate, channels = excluded.channels, fps_num = excluded.fps_num,
         fps_den = excluded.fps_den, codec = excluded.codec, container = excluded.container,
         origin = excluded.origin, parent_asset_id = excluded.parent_asset_id,
         generation_job_id = excluded.generation_job_id, prompt_revision_id = excluded.prompt_revision_id,
         probe_json = excluded.probe_json, updated_at = excluded.updated_at, missing_at = excluded.missing_at`,
      [
        asset.id,
        asset.projectId,
        asset.mediaType,
        asset.storageMode,
        asset.uri,
        asset.relativePath,
        asset.sha256,
        asset.bytes,
        asset.durationFrames,
        asset.width,
        asset.height,
        asset.sampleRate,
        asset.channels,
        asset.fps?.num ?? null,
        asset.fps?.den ?? null,
        asset.codec,
        asset.container,
        asset.origin,
        asset.parentAssetId,
        asset.generationJobId,
        asset.promptRevisionId,
        asset.probe ? JSON.stringify(asset.probe) : null,
        asset.createdAt,
        now,
        asset.missingAt,
      ],
    );
  }

  async insertAsset(asset: Asset): Promise<void> {
    this.driver.transaction(() => this.#upsertAsset(asset, isoNow()));
  }

  async updateAsset(assetId: string, patch: Partial<Asset>): Promise<void> {
    const existing = await this.#getAsset(assetId);
    if (!existing) throw new ConfigurationError(`Unknown asset ${assetId}`);
    const merged = AssetSchema.parse({ ...existing, ...patch, id: assetId, updatedAt: isoNow() });
    this.driver.transaction(() => this.#upsertAsset(merged, isoNow()));
  }

  async #getAsset(assetId: string): Promise<Asset | undefined> {
    const row = this.driver.get<Row>("SELECT * FROM assets WHERE id = ?", [assetId]);
    return row ? mapAsset(row) : undefined;
  }

  async deleteAsset(assetId: string): Promise<void> {
    this.driver.run("DELETE FROM assets WHERE id = ?", [assetId]);
  }

  async listAssets(): Promise<Asset[]> {
    const projectId = this.#requireProjectId();
    return this.driver
      .all<Row>("SELECT * FROM assets WHERE project_id = ? ORDER BY created_at ASC", [projectId])
      .map(mapAsset);
  }

  async findAssetByHash(sha256: string): Promise<Asset | undefined> {
    const projectId = this.#requireProjectId();
    const row = this.driver.get<Row>(
      "SELECT * FROM assets WHERE project_id = ? AND sha256 = ? LIMIT 1",
      [projectId, sha256],
    );
    return row ? mapAsset(row) : undefined;
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  async insertJob(job: GenerationJob): Promise<void> {
    const parsed = GenerationJobSchema.parse(job);
    this.driver.transaction(() => {
      this.driver.run(
        `INSERT INTO generation_jobs (id, project_id, provider_id, model_id, mode, modality, status,
                                      idempotency_key, submission_lock, request_json, provider_job_id,
                                      retry_count, next_poll_at, progress, cost_estimate_json, actual_cost_json,
                                      output_asset_ids_json, error_json, submitted_at, completed_at,
                                      created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          parsed.id,
          parsed.projectId,
          parsed.providerId,
          parsed.modelId,
          parsed.mode,
          parsed.modality,
          parsed.status,
          parsed.idempotencyKey,
          parsed.submissionLock,
          JSON.stringify(parsed.request),
          parsed.providerJobId,
          parsed.retryCount,
          parsed.nextPollAt,
          parsed.progress,
          parsed.costEstimate ? JSON.stringify(parsed.costEstimate) : null,
          parsed.actualCost ? JSON.stringify(parsed.actualCost) : null,
          JSON.stringify(parsed.outputAssetIds),
          parsed.error ? JSON.stringify(parsed.error) : null,
          parsed.submittedAt,
          parsed.completedAt,
          parsed.createdAt,
          parsed.updatedAt,
        ],
      );
    });
    this.#projectId = parsed.projectId;
  }

  async updateJob(
    job: GenerationJob,
    event?: Omit<JobEvent, "id" | "jobId" | "createdAt">,
  ): Promise<void> {
    const parsed = GenerationJobSchema.parse(job);
    this.driver.transaction(() => {
      this.driver.run(
        `UPDATE generation_jobs SET status = ?, submission_lock = ?, provider_job_id = ?, retry_count = ?,
              next_poll_at = ?, progress = ?, cost_estimate_json = ?, actual_cost_json = ?,
              output_asset_ids_json = ?, error_json = ?, submitted_at = ?, completed_at = ?, updated_at = ?
         WHERE id = ?`,
        [
          parsed.status,
          parsed.submissionLock,
          parsed.providerJobId,
          parsed.retryCount,
          parsed.nextPollAt,
          parsed.progress,
          parsed.costEstimate ? JSON.stringify(parsed.costEstimate) : null,
          parsed.actualCost ? JSON.stringify(parsed.actualCost) : null,
          JSON.stringify(parsed.outputAssetIds),
          parsed.error ? JSON.stringify(parsed.error) : null,
          parsed.submittedAt,
          parsed.completedAt,
          parsed.updatedAt,
          parsed.id,
        ],
      );
      if (event) {
        this.driver.run(
          `INSERT INTO job_events (id, job_id, from_state, to_state, detail_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            newId("event"),
            parsed.id,
            event.fromState,
            event.toState,
            event.detail ? JSON.stringify(event.detail) : null,
            isoNow(),
          ],
        );
      }
    });
  }

  async getJob(jobId: string): Promise<GenerationJob | undefined> {
    const row = this.driver.get<Row>("SELECT * FROM generation_jobs WHERE id = ?", [jobId]);
    return row ? mapJob(row) : undefined;
  }

  async listJobs(
    filter: { status?: readonly JobStatus[]; limit?: number } = {},
  ): Promise<GenerationJob[]> {
    const projectId = this.#requireProjectId();
    const clauses = ["project_id = ?"];
    const params: unknown[] = [projectId];
    if (filter.status && filter.status.length > 0) {
      clauses.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
      params.push(...filter.status);
    }
    params.push(filter.limit ?? 500);
    return this.driver
      .all<Row>(
        `SELECT * FROM generation_jobs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
        params,
      )
      .map(mapJob);
  }

  async listJobEvents(jobId: string): Promise<JobEvent[]> {
    return this.driver
      .all<Row>("SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC", [jobId])
      .map((row) => ({
        id: str(row["id"]),
        jobId: str(row["job_id"]),
        fromState: strOrNull(row["from_state"]) as JobStatus | null,
        toState: str(row["to_state"]) as JobStatus,
        detail: json<Record<string, unknown> | null>(row["detail_json"], null),
        createdAt: str(row["created_at"]),
      }));
  }

  /** Jobs left non-terminal by a previous run, plus everything needed to reconcile. */
  async listUnfinishedJobs(): Promise<GenerationJob[]> {
    const projectId = this.#requireProjectId();
    return this.driver
      .all<Row>(
        `SELECT * FROM generation_jobs
         WHERE project_id = ? AND status NOT IN ('completed', 'failed', 'canceled')
         ORDER BY created_at ASC`,
        [projectId],
      )
      .map(mapJob);
  }

  // -------------------------------------------------------------------------
  // Prompt revisions
  // -------------------------------------------------------------------------

  async insertPromptRevision(revision: PromptRevision): Promise<void> {
    const parsed = PromptRevisionSchema.parse(revision);
    this.driver.run(
      `INSERT INTO prompt_revisions (id, job_id, asset_id, prompt, negative_prompt, references_json, seed,
                                     parameters_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parsed.id,
        parsed.jobId,
        parsed.assetId,
        parsed.prompt,
        parsed.negativePrompt,
        JSON.stringify(parsed.references),
        parsed.seed,
        JSON.stringify(parsed.parameters),
        parsed.createdAt,
      ],
    );
  }

  async listPromptRevisions(
    filter: { jobId?: string; assetId?: string; limit?: number } = {},
  ): Promise<PromptRevision[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.jobId) {
      clauses.push("job_id = ?");
      params.push(filter.jobId);
    }
    if (filter.assetId) {
      clauses.push("asset_id = ?");
      params.push(filter.assetId);
    }
    params.push(filter.limit ?? 200);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.driver
      .all<Row>(`SELECT * FROM prompt_revisions ${where} ORDER BY created_at DESC LIMIT ?`, params)
      .map((row): PromptRevision =>
        PromptRevisionSchema.parse({
          id: str(row["id"]),
          jobId: strOrNull(row["job_id"]),
          assetId: strOrNull(row["asset_id"]),
          prompt: str(row["prompt"]),
          negativePrompt: strOrNull(row["negative_prompt"]),
          references: json(row["references_json"], []),
          seed: numOrNull(row["seed"]),
          parameters: json(row["parameters_json"], {}),
          createdAt: str(row["created_at"]),
        }),
      );
  }

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  async insertExportJob(job: ExportJob): Promise<void> {
    const parsed = ExportJobSchema.parse(job);
    this.driver.run(
      `INSERT INTO export_jobs (id, project_id, sequence_id, preset_json, output_path, status, progress,
                                rendered_frames, total_frames, errors_json, log_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parsed.id,
        parsed.projectId,
        parsed.sequenceId,
        JSON.stringify(parsed.preset),
        parsed.outputPath,
        parsed.status,
        parsed.progress,
        parsed.renderedFrames,
        parsed.totalFrames,
        JSON.stringify(parsed.errors),
        parsed.logPath,
        parsed.createdAt,
        parsed.updatedAt,
      ],
    );
    this.#projectId = parsed.projectId;
  }

  async updateExportJob(job: ExportJob): Promise<void> {
    const parsed = ExportJobSchema.parse(job);
    this.driver.run(
      `UPDATE export_jobs SET status = ?, progress = ?, rendered_frames = ?, total_frames = ?,
                              errors_json = ?, log_path = ?, updated_at = ?
       WHERE id = ?`,
      [
        parsed.status,
        parsed.progress,
        parsed.renderedFrames,
        parsed.totalFrames,
        JSON.stringify(parsed.errors),
        parsed.logPath,
        parsed.updatedAt,
        parsed.id,
      ],
    );
  }

  async listExportJobs(limit = 50): Promise<ExportJob[]> {
    const projectId = this.#requireProjectId();
    return this.driver
      .all<Row>("SELECT * FROM export_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?", [
        projectId,
        limit,
      ])
      .map((row): ExportJob =>
        ExportJobSchema.parse({
          id: str(row["id"]),
          projectId: str(row["project_id"]),
          sequenceId: str(row["sequence_id"]),
          preset: ExportPresetSchema.parse(json(row["preset_json"], {})),
          outputPath: str(row["output_path"]),
          status: str(row["status"]),
          progress: num(row["progress"]),
          renderedFrames: num(row["rendered_frames"]),
          totalFrames: num(row["total_frames"]),
          errors: json(row["errors_json"], []),
          logPath: strOrNull(row["log_path"]),
          createdAt: str(row["created_at"]),
          updatedAt: str(row["updated_at"]),
        }),
      );
  }

  // -------------------------------------------------------------------------
  // Provider configs & catalog
  // -------------------------------------------------------------------------

  async upsertProviderConfig(config: ProviderConfigInput): Promise<ProviderConfig> {
    const now = isoNow();
    const projectId = config.projectId ?? this.#requireProjectId();
    const existing = this.driver.get<Row>(
      "SELECT * FROM provider_configs WHERE provider_id = ? AND COALESCE(project_id, '') = COALESCE(?, '')",
      [config.providerId, projectId],
    );
    const parsed = ProviderConfigSchema.parse({
      id: existing ? str(existing["id"]) : newId("providerConfig"),
      projectId,
      providerId: config.providerId,
      enabled: config.enabled ?? (existing ? fromSqlBool(existing["enabled"]) : true),
      baseUrl: config.baseUrl ?? (existing ? strOrNull(existing["base_url"]) : null),
      credentialRef:
        config.credentialRef ?? (existing ? strOrNull(existing["credential_ref"]) : null),
      authScheme: config.authScheme ?? (existing ? str(existing["auth_scheme"]) : "bearer"),
      extraHeaders:
        config.extraHeaders ?? (existing ? json(existing["extra_headers_json"], {}) : {}),
      createdAt: existing ? str(existing["created_at"]) : now,
      updatedAt: now,
    });
    this.driver.run(
      `INSERT INTO provider_configs (id, project_id, provider_id, enabled, base_url, credential_ref,
                                     auth_scheme, extra_headers_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, base_url = excluded.base_url,
         credential_ref = excluded.credential_ref, auth_scheme = excluded.auth_scheme,
         extra_headers_json = excluded.extra_headers_json, updated_at = excluded.updated_at`,
      [
        parsed.id,
        parsed.projectId,
        parsed.providerId,
        parsed.enabled ? 1 : 0,
        parsed.baseUrl,
        parsed.credentialRef,
        parsed.authScheme,
        JSON.stringify(parsed.extraHeaders),
        parsed.createdAt,
        parsed.updatedAt,
      ],
    );
    return parsed;
  }

  async listProviderConfigs(): Promise<ProviderConfig[]> {
    return this.driver
      .all<Row>("SELECT * FROM provider_configs ORDER BY provider_id ASC")
      .map((row): ProviderConfig =>
        ProviderConfigSchema.parse({
          id: str(row["id"]),
          projectId: strOrNull(row["project_id"]),
          providerId: str(row["provider_id"]),
          enabled: fromSqlBool(row["enabled"]),
          baseUrl: strOrNull(row["base_url"]),
          credentialRef: strOrNull(row["credential_ref"]),
          authScheme: str(row["auth_scheme"]),
          extraHeaders: json(row["extra_headers_json"], {}),
          createdAt: str(row["created_at"]),
          updatedAt: str(row["updated_at"]),
        }),
      );
  }

  async deleteProviderConfig(providerId: string): Promise<void> {
    this.driver.run("DELETE FROM provider_configs WHERE provider_id = ?", [providerId]);
  }

  async upsertModelCatalog(entries: readonly ModelCatalogEntry[]): Promise<void> {
    this.driver.transaction(() => {
      for (const entry of entries) {
        this.driver.run(
          `INSERT INTO model_catalog (id, provider_id, model_id, display_name, modality, capabilities_json,
                                      pricing_json, fetched_at, is_stale)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider_id, model_id, modality) DO UPDATE SET
             display_name = excluded.display_name, capabilities_json = excluded.capabilities_json,
             pricing_json = excluded.pricing_json, fetched_at = excluded.fetched_at, is_stale = excluded.is_stale`,
          [
            entry.id,
            entry.providerId,
            entry.modelId,
            entry.displayName,
            entry.modality,
            JSON.stringify(entry.capabilities),
            entry.pricing ? JSON.stringify(entry.pricing) : null,
            entry.fetchedAt,
            entry.isStale ? 1 : 0,
          ],
        );
      }
    });
  }

  async listModelCatalog(providerId?: string): Promise<ModelCatalogEntry[]> {
    const rows = providerId
      ? this.driver.all<Row>(
          "SELECT * FROM model_catalog WHERE provider_id = ? ORDER BY model_id ASC",
          [providerId],
        )
      : this.driver.all<Row>("SELECT * FROM model_catalog ORDER BY provider_id ASC, model_id ASC");
    return rows.map((row) => ({
      id: str(row["id"]),
      providerId: str(row["provider_id"]),
      modelId: str(row["model_id"]),
      displayName: str(row["display_name"]),
      modality: str(row["modality"]),
      capabilities: json(row["capabilities_json"], {}),
      pricing: json<Record<string, unknown> | null>(row["pricing_json"], null),
      fetchedAt: str(row["fetched_at"]),
      isStale: fromSqlBool(row["is_stale"]),
    }));
  }

  // -------------------------------------------------------------------------
  // Spend ledger
  // -------------------------------------------------------------------------

  async recordSpend(
    entry: BudgetLedgerEntry & {
      id: string;
      projectId: string | null;
      jobId: string | null;
      providerId: string;
      createdAt: string;
    },
  ): Promise<void> {
    this.driver.run(
      `INSERT INTO spend_ledger (id, project_id, job_id, provider_id, amount_json, kind, day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.projectId,
        entry.jobId,
        entry.providerId,
        JSON.stringify({ amount: entry.amount, currency: entry.currency }),
        entry.kind,
        entry.day,
        entry.createdAt,
      ],
    );
  }

  async listSpend(
    options: { day?: string; limit?: number } = {},
  ): Promise<Array<BudgetLedgerEntry & { jobId: string | null; providerId: string; day: string }>> {
    const rows = options.day
      ? this.driver.all<Row>("SELECT * FROM spend_ledger WHERE day = ? ORDER BY created_at DESC", [
          options.day,
        ])
      : this.driver.all<Row>("SELECT * FROM spend_ledger ORDER BY created_at DESC LIMIT ?", [
          options.limit ?? 1000,
        ]);
    return rows.map((row) => {
      const amount = json<{ amount: number; currency: string }>(row["amount_json"], {
        amount: 0,
        currency: "USD",
      });
      return {
        amount: amount.amount,
        currency: amount.currency,
        day: str(row["day"]),
        kind: str(row["kind"]) as "estimate" | "actual",
        jobId: strOrNull(row["job_id"]),
        providerId: str(row["provider_id"]),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async getSetting<T = unknown>(key: string): Promise<T | undefined> {
    const row = this.driver.get<Row>("SELECT value_json FROM app_settings WHERE key = ?", [key]);
    if (!row) return undefined;
    return json<T | undefined>(row["value_json"], undefined);
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    this.driver.run(
      `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), isoNow()],
    );
  }

  async allSettings(): Promise<Record<string, unknown>> {
    const rows = this.driver.all<Row>("SELECT key, value_json FROM app_settings");
    const result: Record<string, unknown> = {};
    for (const row of rows) result[str(row["key"])] = json(row["value_json"], null);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapAsset(row: Row): Asset {
  const fpsNum = numOrNull(row["fps_num"]);
  const fpsDen = numOrNull(row["fps_den"]);
  return AssetSchema.parse({
    id: str(row["id"]),
    projectId: str(row["project_id"]),
    mediaType: str(row["media_type"]),
    storageMode: str(row["storage_mode"]),
    uri: str(row["uri"]),
    relativePath: strOrNull(row["relative_path"]),
    sha256: strOrNull(row["sha256"]),
    bytes: numOrNull(row["bytes"]),
    durationFrames: numOrNull(row["duration_frames"]),
    width: numOrNull(row["width"]),
    height: numOrNull(row["height"]),
    sampleRate: numOrNull(row["sample_rate"]),
    channels: numOrNull(row["channels"]),
    fps: fpsNum !== null && fpsDen !== null ? { num: fpsNum, den: fpsDen } : null,
    codec: strOrNull(row["codec"]),
    container: strOrNull(row["container"]),
    origin: str(row["origin"]),
    parentAssetId: strOrNull(row["parent_asset_id"]),
    generationJobId: strOrNull(row["generation_job_id"]),
    promptRevisionId: strOrNull(row["prompt_revision_id"]),
    probe: json<Record<string, unknown> | null>(row["probe_json"], null),
    missingAt: strOrNull(row["missing_at"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  });
}

function mapJob(row: Row): GenerationJob {
  return GenerationJobSchema.parse({
    id: str(row["id"]),
    projectId: str(row["project_id"]),
    providerId: str(row["provider_id"]),
    modelId: str(row["model_id"]),
    mode: str(row["mode"]),
    modality: str(row["modality"]),
    status: str(row["status"]),
    idempotencyKey: strOrNull(row["idempotency_key"]),
    submissionLock: strOrNull(row["submission_lock"]),
    request: json(row["request_json"], {}),
    providerJobId: strOrNull(row["provider_job_id"]),
    retryCount: num(row["retry_count"]),
    nextPollAt: strOrNull(row["next_poll_at"]),
    progress: numOrNull(row["progress"]),
    costEstimate: json<Spend | null>(row["cost_estimate_json"], null),
    actualCost: json<Spend | null>(row["actual_cost_json"], null),
    outputAssetIds: json<string[]>(row["output_asset_ids_json"], []),
    error: json<Record<string, unknown> | null>(row["error_json"], null),
    submittedAt: strOrNull(row["submitted_at"]),
    completedAt: strOrNull(row["completed_at"]),
    createdAt: str(row["created_at"]),
    updatedAt: str(row["updated_at"]),
  });
}
