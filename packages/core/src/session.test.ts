import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { ProjectSession } from "../src/session.js";
import { openWorkspace, pathExists } from "../src/workspace.js";
import { parseManifest } from "../src/manifest.js";
import { loadMigrationsFromDisk, type Migration } from "../src/migrations.js";
import { SqliteProjectStore } from "../src/store/sqlite-store.js";
import { AssetSchema, type Asset, type Clip, type EditorDocument } from "../src/schema.js";
import { newId } from "../src/ids.js";
import { splitClip, TimelineError } from "../src/timeline.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** A manually driven timer so autosave and snapshot scheduling are deterministic. */
function makeTimers() {
  let nextHandle = 1;
  let clock = 0;
  const pending = new Map<number, { fn: () => void; at: number }>();
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const handle = nextHandle++;
        pending.set(handle, { fn, at: clock + ms });
        return handle;
      },
      clearTimeout: (handle: unknown): void => {
        pending.delete(handle as number);
      },
    },
    advance(ms: number): number {
      clock += ms;
      let fired = 0;
      for (const [handle, entry] of [...pending]) {
        if (entry.at <= clock) {
          pending.delete(handle);
          entry.fn();
          fired += 1;
        }
      }
      return fired;
    },
    get pendingCount(): number {
      return pending.size;
    },
  };
}

let root: string;
let migrations: Migration[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "creativelab-session-"));
  migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface HarnessOptions {
  autosaveDebounceMs?: number;
  snapshotIntervalMs?: number;
}

const T0 = Date.parse("2026-06-01T12:00:00.000Z");

async function createSession(label = "Project", options: HarnessOptions = {}) {
  const timers = makeTimers();
  // A controllable clock: "is this snapshot newer than the last save?" is a real
  // question, and a frozen clock cannot express it.
  const clock = {
    current: T0,
    advance(ms: number) {
      this.current += ms;
    },
  };
  const workspace = await openWorkspace(join(root, label));
  const store = new SqliteProjectStore({ filename: workspace.layout.databasePath, migrations });
  const session = await ProjectSession.create(
    {
      workspace,
      store,
      migrations,
      snapshotIntervalMs: options.snapshotIntervalMs ?? 0,
      autosaveDebounceMs: options.autosaveDebounceMs ?? 50,
      timers: timers.timers,
      now: () => new Date(clock.current),
    },
    {
      title: label,
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      createdAt: "2026-06-01T12:00:00.000Z",
    },
  );
  return { session, store, workspace, timers, clock };
}

function videoTrack(document: EditorDocument) {
  return document.tracks.find((track) => track.kind === "video")!;
}

function addClip(document: EditorDocument, startFrame: number, durationFrames: number): Clip {
  const track = videoTrack(document);
  return {
    id: newId("clip"),
    trackId: track.id,
    sequenceId: track.sequenceId,
    assetId: null,
    label: "clip",
    startFrame,
    sourceInFrame: 0,
    durationFrames,
    properties: {
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipX: false, flipY: false },
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
      audio: { gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0, enabled: true, pan: 0 },
      speed: { num: 1, den: 1 },
      transitionIn: { kind: "none", durationFrames: 0 },
      transitionOut: { kind: "none", durationFrames: 0 },
      notes: "",
    },
    version: 1,
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
  } as Clip;
}

function makeAsset(projectId: string, overrides: Partial<Asset> = {}): Asset {
  return AssetSchema.parse({
    id: newId("asset"),
    projectId,
    mediaType: "video",
    uri: "/tmp/source.mp4",
    relativePath: "assets/originals/clip.mp4",
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  });
}

describe("ProjectSession.create (FR-01)", () => {
  it("lays out the workspace, writes the database and an atomic manifest", async () => {
    const { session, workspace } = await createSession("Fresh");

    expect(await pathExists(workspace.layout.databasePath)).toBe(true);
    expect(await pathExists(workspace.layout.manifestPath)).toBe(true);
    expect(await pathExists(join(workspace.layout.root, "assets/originals"))).toBe(true);
    expect(await pathExists(join(workspace.layout.root, "cache/proxies"))).toBe(true);

    const manifest = parseManifest(await readFile(workspace.layout.manifestPath, "utf8"));
    expect(manifest.project.title).toBe("Fresh");
    expect(manifest.project.fps).toEqual({ num: 30, den: 1 });
    expect(manifest.generator).toMatch(/^creativelab\//);
    await session.close();
  });

  it("starts clean, with the FR-03 track set and no pending edits", async () => {
    const { session, timers } = await createSession();
    expect(session.dirty).toBe(false);
    expect(session.document.tracks.filter((track) => track.kind === "video")).toHaveLength(3);
    expect(session.document.tracks.filter((track) => track.kind === "audio")).toHaveLength(4);
    expect(session.historyState()).toMatchObject({ canUndo: false, canRedo: false });
    timers.advance(1_000);
    await session.close();
  });
});

describe("applyEdit, undo and redo (FR-01)", () => {
  it("marks the project dirty and records an undoable step", async () => {
    const { session } = await createSession();
    const clip = addClip(session.document, 0, 60);

    session.applyEdit("Add clip", (document) => ({ ...document, clips: [clip] }));

    expect(session.dirty).toBe(true);
    expect(session.document.clips).toHaveLength(1);
    expect(session.historyState()).toMatchObject({ canUndo: true, undoLabel: "Add clip" });
    await session.close();
  });

  it("restores exact clip geometry through undo and redo", async () => {
    const { session } = await createSession();
    const clip = addClip(session.document, 0, 100);
    session.applyEdit("Add clip", (document) => ({ ...document, clips: [clip] }));

    const split = splitClip(session.document.clips, clip.id, 40);
    session.applyEdit("Split clip", (document) => ({ ...document, clips: split.clips }));
    expect(session.document.clips).toHaveLength(2);

    session.undo();
    expect(session.document.clips).toHaveLength(1);
    expect(session.document.clips[0]!.durationFrames).toBe(100);
    expect(session.historyState()).toMatchObject({
      canUndo: true,
      canRedo: true,
      redoLabel: "Split clip",
    });

    session.redo();
    expect(session.document.clips).toHaveLength(2);
    expect(
      session.document.clips.map((candidate) => candidate.durationFrames).sort((a, b) => a - b),
    ).toEqual([40, 60]);
    await session.close();
  });

  it("rejects an edit that would violate a timeline invariant and keeps the document intact", async () => {
    const { session } = await createSession();
    const good = addClip(session.document, 0, 50);
    session.applyEdit("Add clip", (document) => ({ ...document, clips: [good] }));

    expect(() =>
      session.applyEdit("Break it", (document) => ({
        ...document,
        clips: [good, { ...addClip(document, 25, 50) }],
      })),
    ).toThrow(TimelineError);

    // The failed edit must not have been recorded, applied, or marked dirty.
    expect(session.document.clips).toHaveLength(1);
    expect(session.historyState().undoLabel).toBe("Add clip");
    await session.close();
  });

  it("returns the same document when a mutator is a genuine no-op", async () => {
    const { session } = await createSession();
    const before = session.document;
    const after = session.applyEdit("Nothing", (document) => document);
    expect(after).toBe(before);
    expect(session.dirty).toBe(false);
    await session.close();
  });
});

describe("save and autosave (PRD §14: autosave debounced after changes)", () => {
  it("clears the dirty flag and rewrites the manifest", async () => {
    const { session, workspace } = await createSession();
    session.applyEdit("Add clip", (document) => ({
      ...document,
      clips: [addClip(document, 0, 30)],
    }));
    expect(session.dirty).toBe(true);

    const result = await session.save();
    expect(session.dirty).toBe(false);
    expect(result.clips).toBe(1);
    expect(session.lastSavedAt).toBe(result.savedAt);

    const manifest = parseManifest(await readFile(workspace.layout.manifestPath, "utf8"));
    expect(manifest.clips).toHaveLength(1);
    expect(manifest.clips[0]!.durationFrames).toBe(30);
    await session.close();
  });

  it("debounces a burst of edits into a single autosave", async () => {
    const { session, timers, store } = await createSession(undefined, { autosaveDebounceMs: 50 });
    const clip = addClip(session.document, 0, 30);

    session.applyEdit("Add clip", (document) => ({ ...document, clips: [clip] }));
    session.applyEdit("Rename", (document) => ({ ...document, clips: [{ ...clip, label: "a" }] }));
    session.applyEdit("Rename again", (document) => ({
      ...document,
      clips: [{ ...clip, label: "b" }],
    }));

    // Nothing has been written yet.
    expect(session.dirty).toBe(true);
    expect((await store.loadDocument()).clips).toHaveLength(0);

    timers.advance(49);
    expect(session.dirty).toBe(true);

    timers.advance(2);
    await vi.waitFor(() => expect(session.dirty).toBe(false));
    expect((await store.loadDocument()).clips[0]!.label).toBe("b");
    await session.close();
  });

  it("flushes a pending autosave on demand and on close", async () => {
    const { session, timers, store } = await createSession(undefined, {
      autosaveDebounceMs: 10_000,
    });
    session.applyEdit("Add clip", (document) => ({
      ...document,
      clips: [addClip(document, 0, 30)],
    }));

    expect(timers.pendingCount).toBeGreaterThan(0);
    await session.flushAutosave();
    expect(session.dirty).toBe(false);
    expect((await store.loadDocument()).clips).toHaveLength(1);

    // A second edit flushed by close() must also land. `close()` shuts the database,
    // so the assertion reopens it the way a user relaunching the app would.
    session.applyEdit("Add another", (document) => ({
      ...document,
      clips: [...document.clips, addClip(document, 30, 30)],
    }));
    const databasePath = session.workspace.layout.databasePath;
    await session.close();

    const reopened = new SqliteProjectStore({ filename: databasePath, migrations });
    await reopened.init();
    expect((await reopened.loadDocument()).clips).toHaveLength(2);
    await reopened.close();
    void store;
  });

  it("does not write when there is nothing to save", async () => {
    const { session, workspace } = await createSession();
    const before = await readFile(workspace.layout.manifestPath, "utf8");
    await session.save();
    const after = await readFile(workspace.layout.manifestPath, "utf8");
    // The manifest is rewritten, but with identical timeline content.
    expect(parseManifest(after).clips).toEqual(parseManifest(before).clips);
    await session.close();
  });
});

describe("crash snapshots and recovery (FR-01, PRD §14)", () => {
  it("writes a snapshot only while there are unsaved changes", async () => {
    const { session } = await createSession();
    expect(await session.writeCrashSnapshot("periodic")).toBeNull();

    session.applyEdit("Add clip", (document) => ({
      ...document,
      clips: [addClip(document, 0, 30)],
    }));
    const path = await session.writeCrashSnapshot("periodic");
    expect(path).not.toBeNull();
    expect(await pathExists(path!)).toBe(true);

    const snapshot = JSON.parse(await readFile(path!, "utf8"));
    expect(snapshot.kind).toBe("crash-snapshot");
    expect(snapshot.reason).toBe("periodic");
    expect(snapshot.manifest.clips).toHaveLength(1);
    await session.close();
  });

  it("offers recovery only when the snapshot is newer than the last save", async () => {
    const { session, clock } = await createSession();
    session.applyEdit("Add clip", (document) => ({
      ...document,
      clips: [addClip(document, 0, 30)],
    }));

    // A snapshot taken a minute after the last save is news.
    clock.advance(60_000);
    const snapshotPath = await session.writeCrashSnapshot("periodic");
    expect(snapshotPath).not.toBeNull();
    expect((await session.findRecoverableSnapshot())?.path).toBe(snapshotPath);

    // Saving that same content makes the snapshot redundant, so recovery is withdrawn.
    await session.flushAutosave();
    expect(await session.findRecoverableSnapshot()).toBeNull();
    await session.close();
  });

  it("restores the snapshot into the live document as an undoable step", async () => {
    const { session, store } = await createSession();
    const clip = addClip(session.document, 0, 30);
    session.applyEdit("Add clip", (document) => ({ ...document, clips: [clip] }));
    const snapshotPath = (await session.writeCrashSnapshot("manual"))!;

    // Simulate losing the in-memory work, then recovering it.
    session.replaceDocument({ ...session.document, clips: [] });
    expect(session.document.clips).toHaveLength(0);

    await session.recoverFromSnapshot(snapshotPath);
    expect(session.document.clips).toHaveLength(1);
    expect(session.document.clips[0]!.durationFrames).toBe(30);
    expect(session.historyState().undoLabel).toMatch(/Recovered from snapshot/);

    await session.flushAutosave();
    expect((await store.loadDocument()).clips).toHaveLength(1);
    await session.close();
  });

  it("prunes old snapshots so backups do not grow without bound", async () => {
    const { session, workspace } = await createSession();
    session.applyEdit("Add clip", (document) => ({
      ...document,
      clips: [addClip(document, 0, 30)],
    }));
    for (let index = 0; index < 25; index += 1) {
      await session.writeCrashSnapshot("periodic");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
    }
    const snapshots = (await readdir(join(workspace.layout.root, "backups"))).filter((name) =>
      name.startsWith("snapshot-"),
    );
    expect(snapshots.length).toBeLessThanOrEqual(20);
    await session.close();
  });

  it("rejects a file that is not a crash snapshot", async () => {
    const { session, workspace } = await createSession();
    const bogus = join(workspace.layout.root, "backups", "not-a-snapshot.json");
    await writeFile(bogus, JSON.stringify({ kind: "something-else" }));
    await expect(session.recoverFromSnapshot(bogus)).rejects.toThrow(/not a crash snapshot/i);
    await session.close();
  });
});

describe("reopening a project (FR-01, PRD §11)", () => {
  it("reopens from the database with identical timeline content", async () => {
    const { session, workspace, store } = await createSession("Reopen");
    const clip = addClip(session.document, 0, 45);
    session.applyEdit("Add clip", (document) => ({ ...document, clips: [clip] }));
    await session.flushAutosave();
    await session.close();

    const reopenedStore = new SqliteProjectStore({
      filename: workspace.layout.databasePath,
      migrations,
    });
    const reopened = await ProjectSession.open({
      workspace,
      store: reopenedStore,
      migrations,
      snapshotIntervalMs: 0,
    });

    expect(reopened.document.project.title).toBe("Reopen");
    expect(reopened.document.clips).toHaveLength(1);
    expect(reopened.document.clips[0]!.durationFrames).toBe(45);
    expect(reopened.dirty).toBe(false);
    await reopened.close();
    void store;
  });

  it("rehydrates from project.json when the database is missing (packaged project)", async () => {
    const { session, workspace } = await createSession("Portable");
    session.applyEdit("Add clip", (document) => ({
      ...document,
      clips: [addClip(document, 0, 20)],
    }));
    await session.flushAutosave();
    await session.close();

    // Deleting the working database must not lose the project: the manifest is the
    // portable source of truth (PRD §11).
    await rm(workspace.layout.databasePath, { force: true });

    const store = new SqliteProjectStore({ filename: workspace.layout.databasePath, migrations });
    const reopened = await ProjectSession.open({
      workspace,
      store,
      migrations,
      snapshotIntervalMs: 0,
    });

    expect(reopened.document.project.title).toBe("Portable");
    expect(reopened.document.clips).toHaveLength(1);
    expect(reopened.document.tracks.filter((track) => track.kind === "video")).toHaveLength(3);
    // The database is rebuilt so subsequent saves go through SQLite again.
    expect(await pathExists(workspace.layout.databasePath)).toBe(true);
    expect((await store.loadDocument()).clips).toHaveLength(1);
    await reopened.close();
  });

  it("survives many create/save/reopen cycles without drift (PRD §2 reliability metric)", async () => {
    const directory = join(root, "cycles");
    const workspace = await openWorkspace(directory);

    let lastClipCount = 0;
    for (let cycle = 0; cycle < 12; cycle += 1) {
      const store = new SqliteProjectStore({ filename: workspace.layout.databasePath, migrations });
      const exists = await pathExists(workspace.layout.manifestPath);
      const session = exists
        ? await ProjectSession.open({ workspace, store, migrations, snapshotIntervalMs: 0 })
        : await ProjectSession.create(
            { workspace, store, migrations, snapshotIntervalMs: 0 },
            {
              title: "Cycles",
              fps: { num: 30000, den: 1001 },
              width: 1920,
              height: 1080,
              createdAt: "2026-06-01T12:00:00.000Z",
            },
          );

      // Add one clip per cycle at a strictly increasing offset.
      const clip = addClip(session.document, cycle * 20, 20);
      session.applyEdit(`cycle ${cycle}`, (document) => ({
        ...document,
        clips: [...document.clips, clip],
      }));
      await session.flushAutosave();

      const reloaded = await session.verifyAssets();
      expect(reloaded.checked).toBe(0);
      expect(session.document.project.fps).toEqual({ num: 30000, den: 1001 });
      lastClipCount = session.document.clips.length;
      expect(lastClipCount).toBe(cycle + 1);
      await session.close();
    }
    expect(lastClipCount).toBe(12);

    // Final integrity check of the accumulated database.
    const store = new SqliteProjectStore({ filename: workspace.layout.databasePath, migrations });
    await store.init();
    expect(store.driver.integrityCheck()).toBe("ok");
    const final = await store.loadDocument();
    expect(final.clips).toHaveLength(12);
    expect(final.clips.map((clip) => clip.startFrame)).toEqual(
      Array.from({ length: 12 }, (_, index) => index * 20),
    );
    await store.close();
  });
});

describe("media integrity (FR-02: detect missing paths, relink)", () => {
  it("reports a present asset as ok and a missing one as an issue", async () => {
    const { session, store, workspace } = await createSession();
    await writeFile(join(workspace.originalsDir(), "clip.mp4"), "media");

    const present = makeAsset(session.document.project.id, {
      relativePath: "assets/originals/clip.mp4",
    });
    const missing = makeAsset(session.document.project.id, {
      relativePath: "assets/originals/gone.mp4",
      uri: join(workspace.originalsDir(), "gone.mp4"),
    });
    await store.insertAsset(present);
    await store.insertAsset(missing);
    session.applyEdit("Add assets", (document) => ({ ...document, assets: [present, missing] }));

    const report = await session.verifyAssets();
    expect(report.checked).toBe(2);
    expect(report.ok).toBe(1);
    expect(report.portable).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({ assetId: missing.id, kind: "missing" });
    await session.close();
  });

  it("reports a resolvable linked original as not packaged, not as missing", async () => {
    const { session, store } = await createSession();
    const outside = join(root, "outside-original.mp4");
    await writeFile(outside, "media");
    const linked = makeAsset(session.document.project.id, {
      relativePath: null,
      storageMode: "linked",
      uri: outside,
    });
    await store.insertAsset(linked);
    session.applyEdit("Add asset", (document) => ({ ...document, assets: [linked] }));

    const report = await session.verifyAssets();
    // The file is right there, so it is not "missing" — but it is outside the project,
    // so the project is not portable until it is copied or packaged in.
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({ assetId: linked.id, kind: "not-packaged" });
    expect(report.ok).toBe(0);
    expect(report.portable).toBe(false);
    await session.close();
  });

  it("reports a linked original that has moved away as missing", async () => {
    const { session, store } = await createSession();
    const linked = makeAsset(session.document.project.id, {
      relativePath: null,
      storageMode: "linked",
      uri: join(root, "vanished.mp4"),
    });
    await store.insertAsset(linked);
    session.applyEdit("Add asset", (document) => ({ ...document, assets: [linked] }));

    const report = await session.verifyAssets();
    expect(report.issues[0]).toMatchObject({ assetId: linked.id, kind: "missing" });
    await session.close();
  });

  it("relinks to a file inside the workspace and keeps it portable", async () => {
    const { session, store, workspace } = await createSession();
    const asset = makeAsset(session.document.project.id, {
      relativePath: null,
      storageMode: "linked",
      uri: join(root, "broken.mp4"),
      missingAt: "2026-01-01T00:00:00.000Z",
    });
    await store.insertAsset(asset);
    session.applyEdit("Add asset", (document) => ({ ...document, assets: [asset] }));

    const replacement = join(workspace.originalsDir(), "replacement.mp4");
    await writeFile(replacement, "replacement media");
    const relinked = await session.relinkAsset(asset.id, replacement);

    expect(relinked.relativePath).toBe("assets/originals/replacement.mp4");
    expect(relinked.storageMode).toBe("copied");
    expect(relinked.missingAt).toBeNull();
    expect(relinked.bytes).toBe(Buffer.byteLength("replacement media"));

    const report = await session.verifyAssets();
    expect(report.portable).toBe(true);
    expect(report.issues).toHaveLength(0);
    await session.close();
  });

  it("downgrades to a linked original when the replacement lives outside the workspace", async () => {
    const { session, store } = await createSession();
    const asset = makeAsset(session.document.project.id, {
      relativePath: null,
      storageMode: "linked",
    });
    await store.insertAsset(asset);
    session.applyEdit("Add asset", (document) => ({ ...document, assets: [asset] }));

    const outside = join(root, "elsewhere.mp4");
    await writeFile(outside, "media");
    const relinked = await session.relinkAsset(asset.id, outside);

    expect(relinked.relativePath).toBeNull();
    expect(relinked.storageMode).toBe("linked");
    await session.close();
  });

  it("refuses to relink to a path that is not a readable file", async () => {
    const { session, store } = await createSession();
    const asset = makeAsset(session.document.project.id, {
      relativePath: null,
      storageMode: "linked",
    });
    await store.insertAsset(asset);
    session.applyEdit("Add asset", (document) => ({ ...document, assets: [asset] }));

    await expect(session.relinkAsset(asset.id, join(root, "does-not-exist.mp4"))).rejects.toThrow(
      /not a readable file/i,
    );
    await expect(
      session.relinkAsset("ast_nope00000000000000", join(root, "x.mp4")),
    ).rejects.toThrow(/unknown asset/i);
    await session.close();
  });
});

describe("packageProject (PRD §11: copies all dependencies, validates relinking)", () => {
  it("copies the project without caches or backups and reports it as portable", async () => {
    const { session, store, workspace } = await createSession("Packaged");
    await writeFile(join(workspace.originalsDir(), "clip.mp4"), "media");
    await writeFile(join(workspace.cacheDir("proxies"), "clip.mp4"), "derived");

    const asset = makeAsset(session.document.project.id, {
      relativePath: "assets/originals/clip.mp4",
    });
    await store.insertAsset(asset);
    session.applyEdit("Add asset", (document) => ({
      ...document,
      assets: [asset],
      clips: [addClip(document, 0, 30)],
    }));
    await session.flushAutosave();

    const destination = join(root, "packaged-out");
    const result = await session.packageProject(destination);

    expect(result.destination).toBe(destination);
    expect(result.report.portable).toBe(true);
    expect(result.unresolved).toEqual([]);
    expect(await pathExists(join(destination, "project.json"))).toBe(true);
    expect(await pathExists(join(destination, "assets/originals/clip.mp4"))).toBe(true);
    // Rebuildable caches and prior backups stay behind.
    expect(await pathExists(join(destination, "cache"))).toBe(false);
    expect(await pathExists(join(destination, "backups"))).toBe(false);

    // The packaged copy carries the timeline.
    const manifest = parseManifest(await readFile(join(destination, "project.json"), "utf8"));
    expect(manifest.clips).toHaveLength(1);
    await session.close();
  });

  it("lists linked originals that cannot be made portable", async () => {
    const { session, store } = await createSession("Linked");
    const outside = join(root, "outside.mp4");
    await writeFile(outside, "media");
    const asset = makeAsset(session.document.project.id, {
      relativePath: null,
      storageMode: "linked",
      uri: outside,
    });
    await store.insertAsset(asset);
    session.applyEdit("Add asset", (document) => ({ ...document, assets: [asset] }));
    await session.flushAutosave();

    const result = await session.packageProject(join(root, "packaged-linked"));
    expect(result.unresolved).toContain(asset.id);
    expect(result.report.issues.some((issue) => issue.kind === "not-packaged")).toBe(true);
    await session.close();
  });

  it("refuses to package a project into itself or into a folder inside itself", async () => {
    const { session } = await createSession();
    await expect(session.packageProject(".")).rejects.toThrow(/into itself/i);
    await expect(session.packageProject(join("sub", "nested"))).rejects.toThrow(/inside itself/i);
    await session.close();
  });

  it("refuses a non-empty destination rather than merging two projects together", async () => {
    const { session } = await createSession();
    const destination = join(root, "already-used");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "someone-elses-file.txt"), "not mine");

    await expect(session.packageProject(destination)).rejects.toThrow(/not empty/i);
    // The existing content is left untouched.
    expect(await readFile(join(destination, "someone-elses-file.txt"), "utf8")).toBe("not mine");
    await session.close();
  });
});

describe("session lifecycle", () => {
  it("refuses to accept edits once closed", async () => {
    const { session } = await createSession();
    await session.close();
    expect(() => session.applyEdit("nope", (document) => document)).toThrow(/closed/i);
    await expect(session.save()).rejects.toThrow(/closed/i);
  });

  it("cancels scheduled work on close so no timer fires afterwards", async () => {
    const { session, timers } = await createSession(undefined, {
      autosaveDebounceMs: 10_000,
      snapshotIntervalMs: 20_000,
    });
    session.applyEdit("Add clip", (document) => ({
      ...document,
      clips: [addClip(document, 0, 30)],
    }));
    expect(timers.pendingCount).toBeGreaterThan(0);

    await session.close();
    expect(timers.pendingCount).toBe(0);
  });
});
