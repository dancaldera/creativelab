/**
 * `ProjectSession` — the composition root of the local-first editor.
 *
 * It binds together the four things that must agree for a project to be trustworthy:
 *   1. the in-memory `EditorDocument` (what the UI edits),
 *   2. the undo/redo `History` (FR-01),
 *   3. the SQLite store and the atomic `project.json` manifest (PRD §11),
 *   4. the workspace filesystem, including autosave, crash snapshots and recovery (§14).
 *
 * The UI only ever mutates state through `applyEdit`, so every change is validated,
 * undoable and autosaved by construction.
 */
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { History, type HistoryOptions, type HistoryState } from "./history.js";
import { assertTimelineInvariants, isoNow } from "./timeline.js";
import type { Asset, EditorDocument } from "./schema.js";
import type { CreateProjectInput, ProjectStore, SaveResult } from "./store/types.js";
import type { Migration } from "./migrations.js";
import {
  buildManifest,
  manifestToDocument,
  parseManifest,
  readManifest,
  serializeManifest,
  verifyAssets,
  type RelinkReport,
} from "./manifest.js";
import {
  atomicWriteFile,
  isInside,
  makeWorkspace,
  safeJoin,
  toProjectRelative,
  type Workspace,
} from "./workspace.js";
import { ConfigurationError } from "./errors.js";
import { newId } from "./ids.js";

/** A crash snapshot: the full manifest plus the reason it was written. */
export interface CrashSnapshot {
  readonly kind: "crash-snapshot";
  readonly projectId: string;
  readonly writtenAt: string;
  readonly reason: "periodic" | "before-edit" | "manual";
  readonly manifest: ReturnType<typeof buildManifest>;
}

export interface SessionOptions {
  readonly workspace: Workspace;
  readonly store: ProjectStore;
  readonly migrations?: readonly Migration[];
  readonly history?: HistoryOptions;
  readonly autosaveDebounceMs?: number;
  readonly snapshotIntervalMs?: number;
  readonly now?: () => Date;
  /** Timer injection so tests can drive autosave deterministically. */
  readonly timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  readonly onDocumentChanged?: (document: EditorDocument, label: string) => void;
  readonly onSaved?: (result: SaveResult) => void;
  readonly onError?: (error: Error) => void;
}

export interface PackageResult {
  readonly destination: string;
  readonly files: number;
  readonly bytes: number;
  readonly report: RelinkReport;
  /** Assets that could not be made portable (linked originals outside the workspace). */
  readonly unresolved: readonly string[];
}

const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 1_500;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;

export class ProjectSession {
  readonly workspace: Workspace;
  readonly store: ProjectStore;

  #document: EditorDocument;
  #history: History<EditorDocument>;
  #dirty = false;
  #closed = false;
  #options: SessionOptions;
  #autosaveHandle: unknown = null;
  #snapshotHandle: unknown = null;
  #lastSavedAt: string | null = null;

  private constructor(options: SessionOptions, document: EditorDocument, workspace: Workspace) {
    this.#options = options;
    this.workspace = workspace;
    this.store = options.store;
    this.#document = document;
    this.#history = new History<EditorDocument>(document, options.history ?? {}, () =>
      (options.now?.() ?? new Date()).getTime(),
    );
  }

  /** Create a brand-new project (schema, default tracks, manifest, first save). */
  static async create(options: SessionOptions, input: CreateProjectInput): Promise<ProjectSession> {
    const workspace = options.workspace;
    await options.store.init(options.migrations);
    // Re-open a clean workspace rather than trusting a caller-created directory.
    const ready = await makeWorkspace(workspace.layout.root);
    const document = await options.store.createProject(input);
    const session = new ProjectSession(options, document, ready);
    await session.save();
    session.#startSnapshotTimer();
    return session;
  }

  /**
   * Open an existing project. When the database is empty but a `project.json` exists the
   * manifest is rehydrated, which is what makes a packaged project portable.
   */
  static async open(options: SessionOptions): Promise<ProjectSession> {
    const workspace = options.workspace;
    await options.store.init(options.migrations);
    const ready = await makeWorkspace(workspace.layout.root);

    let document: EditorDocument;
    try {
      document = await options.store.loadDocument();
    } catch (error) {
      const manifestPath = ready.layout.manifestPath;
      const manifest = await readManifest(manifestPath).catch(() => undefined);
      if (!manifest) throw error;
      document = await options.store.createProject({
        id: manifest.project.id,
        title: manifest.project.title,
        fps: manifest.project.fps,
        width: manifest.project.width,
        height: manifest.project.height,
        colorProfile: manifest.project.colorProfile,
        sampleRate: manifest.project.sampleRate,
        channels: manifest.project.channels as 1 | 2,
        createdAt: manifest.project.createdAt,
      });
      document = manifestToDocument(manifest);
      await options.store.saveDocument(document);
    }

    const session = new ProjectSession(options, document, ready);
    session.#lastSavedAt = document.project.updatedAt;
    session.#startSnapshotTimer();
    return session;
  }

  // -------------------------------------------------------------------------
  // Document access
  // -------------------------------------------------------------------------

  get document(): EditorDocument {
    return this.#document;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  get lastSavedAt(): string | null {
    return this.#lastSavedAt;
  }

  historyState(): HistoryState {
    return this.#history.state;
  }

  undoLabels(): string[] {
    return this.#history.undoLabels();
  }

  /**
   * Apply a pure edit. The mutator receives the current document and must return a new
   * one; the result is validated against the timeline invariants before it becomes
   * visible, so the editor can never enter an inconsistent state through the UI.
   */
  applyEdit(
    label: string,
    mutator: (document: EditorDocument) => EditorDocument,
    options: { coalesce?: boolean; validate?: boolean } = {},
  ): EditorDocument {
    this.#assertOpen();
    const next = mutator(this.#document);
    if (next === this.#document) return this.#document;
    if (options.validate !== false) assertTimelineInvariants(next);

    this.#history.push(label, next, { coalesce: options.coalesce }, () =>
      (this.#options.now?.() ?? new Date()).getTime(),
    );
    this.#document = next;
    this.#markDirty(label);
    return next;
  }

  undo(): EditorDocument | undefined {
    const previous = this.#history.undo();
    if (!previous) return undefined;
    this.#document = previous;
    this.#markDirty("Undo");
    return previous;
  }

  redo(): EditorDocument | undefined {
    const next = this.#history.redo();
    if (!next) return undefined;
    this.#document = next;
    this.#markDirty("Redo");
    return next;
  }

  /** Replace the document without creating an undo step (e.g. reload from disk). */
  replaceDocument(document: EditorDocument, label = "Reloaded from disk"): void {
    assertTimelineInvariants(document);
    this.#document = document;
    this.#history.replacePresent(label, document, () =>
      (this.#options.now?.() ?? new Date()).getTime(),
    );
    this.#options.onDocumentChanged?.(document, label);
  }

  #markDirty(label: string): void {
    this.#dirty = true;
    this.#options.onDocumentChanged?.(this.#document, label);
    this.scheduleAutosave();
  }

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------

  /** Persist SQLite + `project.json`. The manifest write is atomic. */
  async save(): Promise<SaveResult> {
    this.#assertOpen();
    const result = await this.store.saveDocument(this.#document);
    // The session owns the save timestamp so that "last saved", the manifest's
    // `exportedAt` and crash-snapshot timestamps all come from one clock. Mixing the
    // session clock with the store's would make snapshot-vs-save comparisons wrong.
    const savedAt = (this.#options.now?.() ?? new Date()).toISOString();
    const manifest = buildManifest(this.#document, new Date(savedAt));
    await atomicWriteFile(this.workspace.layout.manifestPath, serializeManifest(manifest));

    const saveResult: SaveResult = { ...result, savedAt };
    this.#dirty = false;
    this.#lastSavedAt = savedAt;
    this.#options.onSaved?.(saveResult);
    return saveResult;
  }

  scheduleAutosave(): void {
    if (this.#closed) return;
    const timers = this.#timers();
    if (this.#autosaveHandle !== null) timers.clearTimeout(this.#autosaveHandle);
    const delay = this.#options.autosaveDebounceMs ?? DEFAULT_AUTOSAVE_DEBOUNCE_MS;
    this.#autosaveHandle = timers.setTimeout(() => {
      this.#autosaveHandle = null;
      void this.save().catch((error: Error) => this.#options.onError?.(error));
    }, delay);
  }

  /** Run any pending autosave immediately. Call before quitting or exporting. */
  async flushAutosave(): Promise<void> {
    const timers = this.#timers();
    if (this.#autosaveHandle !== null) {
      timers.clearTimeout(this.#autosaveHandle);
      this.#autosaveHandle = null;
    }
    if (this.#dirty) await this.save();
  }

  #timers(): NonNullable<SessionOptions["timers"]> {
    return (
      this.#options.timers ?? {
        setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
        clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
      }
    );
  }

  // -------------------------------------------------------------------------
  // Crash snapshots and recovery
  // -------------------------------------------------------------------------

  #startSnapshotTimer(): void {
    const interval = this.#options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    if (interval <= 0) return;
    const timers = this.#timers();
    const tick = (): void => {
      if (this.#closed) return;
      void this.writeCrashSnapshot("periodic").catch((error: Error) =>
        this.#options.onError?.(error),
      );
      this.#snapshotHandle = timers.setTimeout(tick, interval);
    };
    this.#snapshotHandle = timers.setTimeout(tick, interval);
  }

  /** Write a restorable snapshot. Only written when there are unsaved changes. */
  async writeCrashSnapshot(reason: CrashSnapshot["reason"] = "manual"): Promise<string | null> {
    if (!this.#dirty) return null;
    const now = this.#options.now?.() ?? new Date();
    const snapshot: CrashSnapshot = {
      kind: "crash-snapshot",
      projectId: this.#document.project.id,
      writtenAt: now.toISOString(),
      reason,
      manifest: buildManifest(this.#document, now),
    };
    const directory = safeJoin(this.workspace.layout.root, "backups");
    await mkdir(directory, { recursive: true });
    const target = join(directory, `snapshot-${now.toISOString().replace(/[:.]/g, "-")}.json`);
    await atomicWriteFile(target, `${JSON.stringify(snapshot, null, 2)}\n`);
    await this.#pruneSnapshots(directory, 20);
    return target;
  }

  async #pruneSnapshots(directory: string, keep: number): Promise<void> {
    try {
      const entries = (await readdir(directory))
        .filter((name) => name.startsWith("snapshot-") && name.endsWith(".json"))
        .sort();
      for (const stale of entries.slice(0, Math.max(0, entries.length - keep))) {
        await rm(join(directory, stale), { force: true });
      }
    } catch {
      // Snapshot pruning is best-effort housekeeping.
    }
  }

  /**
   * Find the newest crash snapshot that is strictly newer than the last successful save.
   * Returns `null` when the project on disk is already up to date.
   */
  async findRecoverableSnapshot(): Promise<{ path: string; snapshot: CrashSnapshot } | null> {
    const directory = safeJoin(this.workspace.layout.root, "backups");
    let entries: string[];
    try {
      entries = (await readdir(directory)).filter(
        (name) => name.startsWith("snapshot-") && name.endsWith(".json"),
      );
    } catch {
      return null;
    }
    entries.sort().reverse();
    const savedAt = this.#lastSavedAt ?? this.#document.project.updatedAt;

    for (const name of entries) {
      const path = join(directory, name);
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as CrashSnapshot;
        if (parsed.kind !== "crash-snapshot") continue;
        if (parsed.projectId !== this.#document.project.id) continue;
        if (Date.parse(parsed.writtenAt) <= Date.parse(savedAt)) continue;
        return { path, snapshot: parsed };
      } catch {
        continue;
      }
    }
    return null;
  }

  /** Load a crash snapshot into the session, preserving undo history. */
  async recoverFromSnapshot(path: string): Promise<EditorDocument> {
    const snapshot = JSON.parse(await readFile(path, "utf8")) as CrashSnapshot;
    if (snapshot.kind !== "crash-snapshot") {
      throw new ConfigurationError(`Not a crash snapshot: ${path}`);
    }
    const document = parseManifest(JSON.stringify(snapshot.manifest));
    this.applyEdit(
      `Recovered from snapshot ${snapshot.writtenAt}`,
      () => manifestToDocument(document),
      {
        validate: true,
      },
    );
    return this.#document;
  }

  // -------------------------------------------------------------------------
  // Media integrity
  // -------------------------------------------------------------------------

  async verifyAssets(): Promise<RelinkReport> {
    return verifyAssets(this.workspace.layout.root, this.#document.assets);
  }

  /**
   * Point an asset at a new file. Copied assets are relinked in place; a newly supplied
   * path outside the workspace downgrades the asset to a linked original.
   */
  async relinkAsset(assetId: string, newAbsolutePath: string): Promise<Asset> {
    const asset = this.#document.assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new ConfigurationError(`Unknown asset ${assetId}`);
    const info = await stat(newAbsolutePath).catch(() => undefined);
    if (!info?.isFile()) throw new ConfigurationError(`Not a readable file: ${newAbsolutePath}`);

    const relativePath = toProjectRelative(this.workspace.layout.root, newAbsolutePath);
    const patched: Asset = {
      ...asset,
      uri: newAbsolutePath,
      relativePath,
      storageMode: relativePath ? "copied" : "linked",
      bytes: info.size,
      missingAt: null,
      updatedAt: isoNow(),
    };
    await this.store.updateAsset(assetId, patched);
    this.applyEdit(`Relinked ${asset.relativePath ?? assetId}`, (document) => ({
      ...document,
      assets: document.assets.map((candidate) => (candidate.id === assetId ? patched : candidate)),
    }));
    return patched;
  }

  // -------------------------------------------------------------------------
  // Packaging (PRD §11)
  // -------------------------------------------------------------------------

  /**
   * Copy the project and every dependency into `destination`, excluding rebuildable
   * caches and previous backups, then validate that the copy relinks cleanly.
   */
  async packageProject(destination: string): Promise<PackageResult> {
    await this.flushAutosave();
    const root = this.workspace.layout.root;
    const target = destination.startsWith("/") ? destination : join(root, destination);
    if (target === root) throw new ConfigurationError("Refusing to package a project into itself");
    if (isInside(root, target)) {
      throw new ConfigurationError("Refusing to package a project into a folder inside itself");
    }
    // Refuse a non-empty destination instead of merging into it. Merging could mix media
    // from two different projects, and deleting the user's folder to make room would be
    // worse. The caller picks a clean path.
    const existing = await readdir(target).catch(() => [] as string[]);
    if (existing.length > 0) {
      throw new ConfigurationError(
        `Destination is not empty: ${target}. Choose a new folder so the packaged project is unambiguous.`,
      );
    }
    await mkdir(target, { recursive: true });

    const excluded = new Set(["cache", "backups"]);
    let files = 0;
    let bytes = 0;

    const copyTree = async (absolute: string, relative: string): Promise<void> => {
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (!relative && excluded.has(entry.name)) continue;
        const source = join(absolute, entry.name);
        if (entry.isDirectory()) {
          await copyTree(source, childRelative);
        } else if (entry.isFile()) {
          const destinationPath = safeJoin(target, childRelative);
          await mkdir(dirname(destinationPath), { recursive: true });
          await copyFile(source, destinationPath);
          files += 1;
          bytes += (await stat(source)).size;
        }
      }
    };
    await copyTree(root, "");

    // Validate the *copy*, not the original: that is what proves portability.
    const destinationWorkspace = makeWorkspace(target);
    const report = await verifyAssets(destinationWorkspace.layout.root, this.#document.assets);
    const unresolved = report.issues
      .filter((issue) => issue.kind !== "missing")
      .map((issue) => issue.assetId);

    return { destination: target, files, bytes, report, unresolved };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.flushAutosave();
    const timers = this.#timers();
    if (this.#snapshotHandle !== null) timers.clearTimeout(this.#snapshotHandle);
    if (this.#autosaveHandle !== null) timers.clearTimeout(this.#autosaveHandle);
    this.#snapshotHandle = null;
    this.#autosaveHandle = null;
    this.#closed = true;
    await this.store.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new ConfigurationError("This project session is closed");
  }
}

/** A session id, useful for tagging log lines and recovery events. */
export function newSessionId(): string {
  return newId("snapshot");
}

export type { EditorDocument };
