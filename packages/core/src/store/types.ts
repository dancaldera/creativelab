/**
 * Persistence boundary.
 *
 * The editor talks to `ProjectStore`, never to SQL. Two implementations exist:
 *   * `SqliteProjectStore` (node:sqlite) — tests, CLI, headless render,
 *   * the Rust `TauriProjectStore` — the packaged desktop app, same schema.
 * The interface is async because the Tauri implementation is an IPC round trip.
 */
import type {
  Asset,
  EditorDocument,
  ExportJob,
  ExportPreset,
  GenerationJob,
  JobStatus,
  Keyframe,
  PromptRevision,
  ProviderConfig,
  Spend,
} from "../schema.js";
import type { AppliedMigration, Migration } from "../migrations.js";
import type { BudgetLedgerEntry } from "../budget.js";

export interface CreateProjectInput {
  readonly title: string;
  readonly fps: { num: number; den: number };
  readonly width: number;
  readonly height: number;
  readonly colorProfile?: "bt709" | "bt2020" | "srgb" | "p3-d65";
  readonly sampleRate?: number;
  readonly channels?: 1 | 2;
  /** Explicit id, used when rehydrating a project from `project.json`. */
  readonly id?: string;
  readonly createdAt?: string;
}

export interface JobEvent {
  readonly id: string;
  readonly jobId: string;
  readonly fromState: JobStatus | null;
  readonly toState: JobStatus;
  readonly detail: Record<string, unknown> | null;
  readonly createdAt: string;
}

export interface ModelCatalogEntry {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly modality: string;
  readonly capabilities: Record<string, unknown>;
  readonly pricing: Record<string, unknown> | null;
  readonly fetchedAt: string;
  readonly isStale: boolean;
}

export interface ProviderConfigInput {
  readonly providerId: string;
  readonly projectId?: string | null;
  readonly enabled?: boolean;
  readonly baseUrl?: string | null;
  readonly credentialRef?: string | null;
  readonly authScheme?: ProviderConfig["authScheme"];
  readonly extraHeaders?: Record<string, string>;
}

export interface ExportJobInput {
  readonly sequenceId: string;
  readonly preset: ExportPreset;
  readonly outputPath: string;
  readonly totalFrames: number;
}

/** Result of a save attempt, including whether the on-disk manifest was rewritten. */
export interface SaveResult {
  readonly savedAt: string;
  readonly schemaVersion: number;
  readonly clips: number;
  readonly tracks: number;
}

export interface ProjectStore {
  /** Apply pending migrations; safe to call on every startup. */
  init(migrations?: readonly Migration[]): Promise<readonly AppliedMigration[]>;
  schemaVersion(): Promise<number>;
  close(): Promise<void>;

  createProject(input: CreateProjectInput): Promise<EditorDocument>;
  loadDocument(): Promise<EditorDocument>;
  /** Atomically replace the editable document. */
  saveDocument(document: EditorDocument): Promise<SaveResult>;
  renameProject(title: string): Promise<void>;
  listProjects(): Promise<Array<{ id: string; title: string; updatedAt: string }>>;

  // Assets
  insertAsset(asset: Asset): Promise<void>;
  updateAsset(assetId: string, patch: Partial<Asset>): Promise<void>;
  deleteAsset(assetId: string): Promise<void>;
  listAssets(): Promise<Asset[]>;
  findAssetByHash(sha256: string): Promise<Asset | undefined>;

  // Jobs
  insertJob(job: GenerationJob): Promise<void>;
  updateJob(
    job: GenerationJob,
    event?: Omit<JobEvent, "id" | "jobId" | "createdAt">,
  ): Promise<void>;
  getJob(jobId: string): Promise<GenerationJob | undefined>;
  listJobs(filter?: { status?: readonly JobStatus[]; limit?: number }): Promise<GenerationJob[]>;
  listJobEvents(jobId: string): Promise<JobEvent[]>;

  // Prompts
  insertPromptRevision(revision: PromptRevision): Promise<void>;
  listPromptRevisions(filter?: {
    jobId?: string;
    assetId?: string;
    limit?: number;
  }): Promise<PromptRevision[]>;

  // Exports
  insertExportJob(job: ExportJob): Promise<void>;
  updateExportJob(job: ExportJob): Promise<void>;
  listExportJobs(limit?: number): Promise<ExportJob[]>;

  // Providers
  upsertProviderConfig(config: ProviderConfigInput): Promise<ProviderConfig>;
  listProviderConfigs(): Promise<ProviderConfig[]>;
  deleteProviderConfig(providerId: string): Promise<void>;
  upsertModelCatalog(entries: readonly ModelCatalogEntry[]): Promise<void>;
  listModelCatalog(providerId?: string): Promise<ModelCatalogEntry[]>;

  // Budget
  recordSpend(
    entry: BudgetLedgerEntry & {
      id: string;
      projectId: string | null;
      jobId: string | null;
      providerId: string;
      createdAt: string;
    },
  ): Promise<void>;
  listSpend(options?: {
    day?: string;
    limit?: number;
  }): Promise<Array<BudgetLedgerEntry & { jobId: string | null; providerId: string; day: string }>>;

  // Settings
  getSetting<T = unknown>(key: string): Promise<T | undefined>;
  setSetting(key: string, value: unknown): Promise<void>;
  allSettings(): Promise<Record<string, unknown>>;
}

/** Everything needed to create a brand-new project. */
export interface NewProjectRequest extends CreateProjectInput {
  readonly workspaceRoot: string;
}

export type { Keyframe, Spend };
