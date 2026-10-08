import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadMigrationsFromDisk, type Migration } from "../../src/migrations.js";
import { SqliteProjectStore } from "../../src/store/sqlite-store.js";
import {
  AssetSchema,
  ExportJobSchema,
  GenerationJobSchema,
  PromptRevisionSchema,
  type Asset,
  type Clip,
  type ExportJob,
  type GenerationJob,
  type PromptRevision,
} from "../../src/schema.js";
import { createInitialDocument } from "../../src/timeline.js";
import { newId } from "../../src/ids.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = "prj_test000000000000000001";

let store: SqliteProjectStore;
let migrations: Migration[];

beforeEach(async () => {
  migrations = await loadMigrationsFromDisk(MIGRATIONS_DIR);
  store = new SqliteProjectStore({ filename: ":memory:", journalMode: "memory", migrations });
  await store.init();
});

afterEach(async () => {
  try {
    await store.close();
  } catch {
    // Some tests close explicitly.
  }
});

async function seedProject() {
  return store.createProject({
    id: PROJECT_ID,
    title: "Integration project",
    fps: { num: 30000, den: 1001 },
    width: 1920,
    height: 1080,
    createdAt: NOW,
  });
}

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return AssetSchema.parse({
    id: newId("asset"),
    projectId: PROJECT_ID,
    mediaType: "video",
    uri: "/tmp/clip.mp4",
    relativePath: "assets/originals/clip.mp4",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function makeJob(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return GenerationJobSchema.parse({
    id: newId("job"),
    projectId: PROJECT_ID,
    providerId: "mock",
    modelId: "mock-video",
    mode: "text-to-video",
    modality: "video",
    status: "queued",
    request: { prompt: "a lighthouse at dusk" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function makeClip(
  document: Awaited<ReturnType<typeof seedProject>>,
  startFrame: number,
  durationFrames: number,
): Clip {
  const track = document.tracks.find((candidate) => candidate.kind === "video")!;
  return {
    id: newId("clip"),
    trackId: track.id,
    sequenceId: track.sequenceId,
    assetId: null,
    label: "shot",
    startFrame,
    sourceInFrame: 0,
    durationFrames,
    properties: {
      ...document.clips[0]?.properties,
      transform: {
        x: 10,
        y: -5,
        scale: 1.25,
        rotation: 0,
        opacity: 0.5,
        flipX: false,
        flipY: false,
      },
      crop: { top: 0, right: 0.1, bottom: 0, left: 0 },
      audio: { gainDb: -6, fadeInFrames: 12, fadeOutFrames: 0, enabled: true, pan: 0 },
      speed: { num: 1, den: 1 },
      transitionIn: { kind: "crossfade", durationFrames: 10 },
      transitionOut: { kind: "none", durationFrames: 0 },
      notes: "hero shot",
    },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  } as Clip;
}

describe("project lifecycle", () => {
  it("creates a project with the FR-03 default track set", async () => {
    const document = await seedProject();
    expect(document.project.title).toBe("Integration project");
    expect(document.tracks.filter((track) => track.kind === "video")).toHaveLength(3);
    expect(document.tracks.filter((track) => track.kind === "audio")).toHaveLength(4);
    expect(document.sequences).toHaveLength(1);
  });

  it("round-trips project settings exactly, including the NTSC rational", async () => {
    await seedProject();
    const reloaded = await store.loadDocument();
    expect(reloaded.project.fps).toEqual({ num: 30000, den: 1001 });
    expect(reloaded.project.width).toBe(1920);
    expect(reloaded.project.colorProfile).toBe("bt709");
  });

  it("refuses to load before a project exists", async () => {
    await expect(store.loadDocument()).rejects.toThrow(/no project/i);
  });

  it("renames and lists projects", async () => {
    await seedProject();
    await store.renameProject("Renamed");
    const projects = await store.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.title).toBe("Renamed");
  });

  it("reports the applied schema version", async () => {
    expect(await store.schemaVersion()).toBe(1);
  });
});

describe("saveDocument (FR-01: save is atomic)", () => {
  it("persists clip geometry and every nested property group", async () => {
    const document = await seedProject();
    const clip = makeClip(document, 100, 50);
    await store.saveDocument({ ...document, clips: [clip] });

    const reloaded = await store.loadDocument();
    expect(reloaded.clips).toHaveLength(1);
    const restored = reloaded.clips[0]!;
    expect([restored.startFrame, restored.durationFrames, restored.sourceInFrame]).toEqual([
      100, 50, 0,
    ]);
    expect(restored.properties.transform).toMatchObject({
      x: 10,
      y: -5,
      scale: 1.25,
      opacity: 0.5,
    });
    expect(restored.properties.crop.right).toBe(0.1);
    expect(restored.properties.audio).toMatchObject({ gainDb: -6, fadeInFrames: 12 });
    expect(restored.properties.transitionIn).toMatchObject({
      kind: "crossfade",
      durationFrames: 10,
    });
    expect(restored.properties.notes).toBe("hero shot");
  });

  it("mirrors the speed into queryable columns and reads it back from the JSON", async () => {
    const document = await seedProject();
    const base = makeClip(document, 0, 100);
    const clip: Clip = { ...base, properties: { ...base.properties, speed: { num: 2, den: 1 } } };
    await store.saveDocument({ ...document, clips: [clip] });

    const row = store.driver.get<{ speed_num: number; speed_den: number }>(
      "SELECT speed_num, speed_den FROM clips WHERE id = ?",
      [clip.id],
    );
    expect(row).toMatchObject({ speed_num: 2, speed_den: 1 });
    expect((await store.loadDocument()).clips[0]!.properties.speed).toEqual({ num: 2, den: 1 });
  });

  it("replaces the timeline rather than accumulating rows", async () => {
    const document = await seedProject();
    await store.saveDocument({
      ...document,
      clips: [makeClip(document, 0, 30), makeClip(document, 30, 30)],
    });
    expect((await store.loadDocument()).clips).toHaveLength(2);

    await store.saveDocument({ ...document, clips: [makeClip(document, 0, 30)] });
    expect((await store.loadDocument()).clips).toHaveLength(1);
  });

  it("persists effects and keyframes linked to their clips", async () => {
    const document = await seedProject();
    const clip = makeClip(document, 0, 30);
    const effect = {
      id: newId("effect"),
      clipId: clip.id,
      kind: "brightness" as const,
      sortOrder: 0,
      enabled: true,
      params: { amount: 0.2 },
      createdAt: NOW,
      updatedAt: NOW,
    };
    const keyframe = {
      id: newId("keyframe"),
      effectId: effect.id,
      property: "params.amount",
      frame: 15,
      value: 0.8,
      easing: "ease-in-out" as const,
      createdAt: NOW,
    };
    await store.saveDocument({
      ...document,
      clips: [clip],
      effects: [effect],
      keyframes: [keyframe],
    });

    const reloaded = await store.loadDocument();
    expect(reloaded.effects).toHaveLength(1);
    expect(reloaded.effects[0]!.params).toEqual({ amount: 0.2 });
    expect(reloaded.keyframes).toHaveLength(1);
    expect(reloaded.keyframes[0]).toMatchObject({
      property: "params.amount",
      frame: 15,
      value: 0.8,
    });
  });

  it("rolls back and preserves the previous state when a save violates a constraint", async () => {
    const document = await seedProject();
    await store.saveDocument({ ...document, clips: [makeClip(document, 0, 30)] });

    // A clip on a track that does not exist must be rejected by the foreign key and
    // must not leave the database half-written (PRD §14).
    const orphan = makeClip(document, 0, 30);
    const broken = {
      ...document,
      clips: [{ ...orphan, trackId: "trk_ghost00000000000000" } as Clip],
    };
    await expect(store.saveDocument(broken)).rejects.toThrow();

    const recovered = await store.loadDocument();
    expect(recovered.clips).toHaveLength(1);
    expect(recovered.clips[0]!.trackId).toBe(orphan.trackId);
  });

  it("inserts assets before clips so a project can be rehydrated into a fresh database", async () => {
    // Regression: `saveDocument` used to upsert assets *after* the timeline. A project
    // reopened from `project.json` into an empty database therefore failed
    // `clips.asset_id` foreign-key validation — the portability path in PRD §11.
    const document = await seedProject();
    const asset = makeAsset({ mediaType: "video" });
    const clip = { ...makeClip(document, 0, 45), assetId: asset.id } as Clip;

    // Nothing is inserted individually here: the document carries both rows and the
    // ordering inside one transaction is what is under test.
    await expect(
      store.saveDocument({ ...document, clips: [clip], assets: [asset] }),
    ).resolves.toBeDefined();

    const reloaded = await store.loadDocument();
    expect(reloaded.assets).toHaveLength(1);
    expect(reloaded.clips[0]!.assetId).toBe(asset.id);
  });

  it("resolves a generated variant's parent asset within the same save", async () => {
    const document = await seedProject();
    const parent = makeAsset({ origin: "imported" });
    const variant = makeAsset({
      origin: "generated",
      mediaType: "image",
      parentAssetId: parent.id,
    });
    // The variant is listed first on purpose: `assets.parent_asset_id` is a self-FK, so
    // ordering inside the document must not matter.
    await store.saveDocument({ ...document, assets: [variant, parent] });

    const reloaded = await store.loadDocument();
    expect(reloaded.assets).toHaveLength(2);
    expect(reloaded.assets.find((candidate) => candidate.id === variant.id)!.parentAssetId).toBe(
      parent.id,
    );
  });

  it("reports what it saved", async () => {
    const document = await seedProject();
    const result = await store.saveDocument({ ...document, clips: [makeClip(document, 0, 30)] });
    expect(result).toMatchObject({ schemaVersion: 1, clips: 1, tracks: document.tracks.length });
    expect(Date.parse(result.savedAt)).toBeGreaterThan(0);
  });
});

describe("assets", () => {
  it("inserts, lists and finds assets by content hash", async () => {
    await seedProject();
    const asset = makeAsset({
      sha256: "a".repeat(64),
      bytes: 2048,
      width: 1920,
      height: 1080,
      codec: "h264",
    });
    await store.insertAsset(asset);

    const listed = await store.listAssets();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ sha256: "a".repeat(64), width: 1920, codec: "h264" });
    expect((await store.findAssetByHash("a".repeat(64)))?.id).toBe(asset.id);
    expect(await store.findAssetByHash("b".repeat(64))).toBeUndefined();
  });

  it("preserves the rational frame rate and nullable probe payload", async () => {
    await seedProject();
    const asset = makeAsset({ fps: { num: 24000, den: 1001 }, probe: { streams: [{ index: 0 }] } });
    await store.insertAsset(asset);

    const [reloaded] = await store.listAssets();
    expect(reloaded!.fps).toEqual({ num: 24000, den: 1001 });
    expect(reloaded!.probe).toEqual({ streams: [{ index: 0 }] });
    expect(reloaded!.missingAt).toBeNull();
  });

  it("updates a subset of asset fields without dropping the rest", async () => {
    await seedProject();
    const asset = makeAsset({ width: 1920, height: 1080 });
    await store.insertAsset(asset);
    await store.updateAsset(asset.id, { missingAt: NOW, storageMode: "linked" });

    const [reloaded] = await store.listAssets();
    expect(reloaded!.missingAt).toBe(NOW);
    expect(reloaded!.storageMode).toBe("linked");
    expect(reloaded!.width).toBe(1920);
  });

  it("deletes an asset explicitly and refuses to update an unknown one", async () => {
    await seedProject();
    const asset = makeAsset();
    await store.insertAsset(asset);
    await store.deleteAsset(asset.id);
    expect(await store.listAssets()).toHaveLength(0);
    await expect(store.updateAsset("ast_nope00000000000000", { width: 1 })).rejects.toThrow(
      /unknown asset/i,
    );
  });

  it("keeps the provenance link from a generated variant back to its source", async () => {
    await seedProject();
    const original = makeAsset({ origin: "imported" });
    await store.insertAsset(original);
    const variant = makeAsset({
      origin: "generated",
      mediaType: "image",
      parentAssetId: original.id,
      generationJobId: "job_aaaa000000000000000001",
      promptRevisionId: "prv_aaaa000000000000000001",
    });
    await store.insertAsset(variant);

    const [source, derived] = (await store.listAssets()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    expect(derived!.parentAssetId).toBe(source!.id);
  });
});

describe("generation jobs (PRD §12)", () => {
  it("inserts and reads a job back with all nullable fields intact", async () => {
    await seedProject();
    const job = makeJob({ idempotencyKey: "idem_abc", status: "submitting", progress: 0.25 });
    await store.insertJob(job);

    const reloaded = await store.getJob(job.id);
    expect(reloaded).toMatchObject({
      id: job.id,
      status: "submitting",
      idempotencyKey: "idem_abc",
      progress: 0.25,
    });
    expect(reloaded!.request).toEqual({ prompt: "a lighthouse at dusk" });
    expect(reloaded!.outputAssetIds).toEqual([]);
  });

  it("appends an audit event on every state change", async () => {
    await seedProject();
    const job = makeJob();
    await store.insertJob(job);
    await store.updateJob(
      { ...job, status: "validating", updatedAt: "2026-01-01T00:00:01.000Z" },
      { fromState: "queued", toState: "validating", detail: { attempt: 1 } },
    );
    await store.updateJob(
      { ...job, status: "submitting", updatedAt: "2026-01-01T00:00:02.000Z" },
      { fromState: "validating", toState: "submitting", detail: null },
    );

    const events = await store.listJobEvents(job.id);
    expect(events.map((event) => `${event.fromState}->${event.toState}`)).toEqual([
      "queued->validating",
      "validating->submitting",
    ]);
    expect(events[0]!.detail).toEqual({ attempt: 1 });
  });

  it("persists cost estimates and actuals as separate fields", async () => {
    await seedProject();
    const job = makeJob();
    await store.insertJob(job);
    await store.updateJob({
      ...job,
      costEstimate: { amount: 0.42, currency: "USD", isEstimate: true },
      actualCost: { amount: 0.4, currency: "USD", isEstimate: false },
    });

    const reloaded = await store.getJob(job.id);
    expect(reloaded!.costEstimate).toMatchObject({ amount: 0.42, currency: "USD" });
    expect(reloaded!.actualCost).toMatchObject({ amount: 0.4, isEstimate: false });
  });

  it("filters jobs by status and lists unfinished jobs for reconciliation", async () => {
    await seedProject();
    const statuses = [
      "queued",
      "running",
      "submitting",
      "completed",
      "failed",
      "canceled",
      "unknown",
    ] as const;
    const jobs = statuses.map((status, index) =>
      makeJob({
        id: newId("job"),
        status,
        createdAt: `2026-01-01T00:00:0${index}.000Z`,
      }),
    );
    for (const job of jobs) await store.insertJob(job);

    expect(
      (await store.listJobs({ status: ["running", "submitting"] })).map((job) => job.status).sort(),
    ).toEqual(["running", "submitting"]);
    // Everything not terminal must come back so a restart can reconcile it.
    const unfinished = await store.listUnfinishedJobs();
    expect(unfinished.map((job) => job.status).sort()).toEqual([
      "queued",
      "running",
      "submitting",
      "unknown",
    ]);
  });

  it("stores the submission lock so a crash-recovery pass can see it", async () => {
    await seedProject();
    const job = makeJob({ status: "submitting", submissionLock: `${NOW}|evt_lock` });
    await store.insertJob(job);
    expect((await store.getJob(job.id))!.submissionLock).toBe(`${NOW}|evt_lock`);
  });
});

describe("prompt revisions (PRD §10: generation traceability)", () => {
  it("records the prompt, references, seed and parameters", async () => {
    await seedProject();
    const revision: PromptRevision = PromptRevisionSchema.parse({
      id: newId("promptRevision"),
      jobId: null,
      assetId: null,
      prompt: "a lighthouse at dusk, 35mm",
      negativePrompt: "blurry",
      references: ["ast_ref00000000000000001"],
      seed: 42,
      parameters: { guidance: 7.5, steps: 30 },
      createdAt: NOW,
    });
    await store.insertPromptRevision(revision);

    const [reloaded] = await store.listPromptRevisions();
    expect(reloaded).toMatchObject({
      prompt: "a lighthouse at dusk, 35mm",
      negativePrompt: "blurry",
      seed: 42,
    });
    expect(reloaded!.references).toEqual(["ast_ref00000000000000001"]);
    expect(reloaded!.parameters).toEqual({ guidance: 7.5, steps: 30 });
  });

  it("filters revisions by job and asset", async () => {
    await seedProject();
    // `job_id` and `asset_id` are real foreign keys, so both must exist first.
    const job = makeJob();
    await store.insertJob(job);
    const assetX = makeAsset({ mediaType: "image" });
    const assetY = makeAsset({ mediaType: "image" });
    await store.insertAsset(assetX);
    await store.insertAsset(assetY);
    for (const seed of [1, 2, 3]) {
      await store.insertPromptRevision(
        PromptRevisionSchema.parse({
          id: newId("promptRevision"),
          jobId: job.id,
          assetId: seed === 1 ? assetX.id : assetY.id,
          prompt: `prompt ${seed}`,
          seed,
          createdAt: NOW,
        }),
      );
    }
    expect(await store.listPromptRevisions({ jobId: job.id })).toHaveLength(3);
    expect(await store.listPromptRevisions({ assetId: assetX.id })).toHaveLength(1);
  });
});

describe("export jobs (FR-09)", () => {
  function makeExportJob(overrides: Partial<ExportJob> = {}): ExportJob {
    return ExportJobSchema.parse({
      id: newId("exportJob"),
      projectId: PROJECT_ID,
      sequenceId: "seq_aaaa000000000000000001",
      preset: {
        id: "1080p",
        label: "1080p H.264",
        width: 1920,
        height: 1080,
        fps: { num: 30, den: 1 },
      },
      outputPath: "/tmp/out.mp4",
      status: "queued",
      totalFrames: 900,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    });
  }

  it("records progress and terminal errors", async () => {
    await seedProject();
    const job = makeExportJob();
    await store.insertExportJob(job);
    await store.updateExportJob({
      ...job,
      status: "rendering",
      progress: 0.5,
      renderedFrames: 450,
      updatedAt: "2026-01-01T00:01:00.000Z",
    });

    const [reloaded] = await store.listExportJobs();
    expect(reloaded).toMatchObject({ status: "rendering", renderedFrames: 450, totalFrames: 900 });
    expect(reloaded!.progress).toBe(0.5);
    expect(reloaded!.preset.id).toBe("1080p");

    await store.updateExportJob({
      ...job,
      status: "failed",
      errors: ["ffmpeg exited 1"],
      updatedAt: NOW,
    });
    expect((await store.listExportJobs())[0]!.errors).toEqual(["ffmpeg exited 1"]);
  });

  it("survives deletion of the sequence it rendered, as an audit record", async () => {
    const document = await seedProject();
    const job = makeExportJob({ sequenceId: document.sequences[0]!.id });
    await store.insertExportJob(job);

    // A normal save replaces sequences; the export log must not be cascaded away.
    await store.saveDocument({ ...createInitialDocument(document.project) });
    expect(await store.listExportJobs()).toHaveLength(1);
  });
});

describe("provider configuration (PRD §13: no secrets in the database)", () => {
  it("stores only a credential handle, never the key", async () => {
    await seedProject();
    const config = await store.upsertProviderConfig({
      providerId: "elevenlabs",
      credentialRef: "provider:elevenlabs",
      authScheme: "x-api-key",
    });

    expect(config.credentialRef).toBe("provider:elevenlabs");
    const [reloaded] = await store.listProviderConfigs();
    expect(reloaded!.credentialRef).toBe("provider:elevenlabs");
    // The table has no column capable of holding a secret at all.
    const columns = store.driver.all<{ name: string }>("PRAGMA table_info(provider_configs)");
    const names = columns.map((column) => column.name);
    expect(names).toContain("credential_ref");
    expect(names.some((name) => /key|secret|token|password/i.test(name))).toBe(false);
  });

  it("upserts rather than duplicating a provider row", async () => {
    await seedProject();
    await store.upsertProviderConfig({ providerId: "vercel", baseUrl: "https://example.test" });
    await store.upsertProviderConfig({ providerId: "vercel", enabled: false });

    const configs = await store.listProviderConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ providerId: "vercel", enabled: false });
    expect(configs[0]!.baseUrl).toBe("https://example.test");
  });

  it("deletes a provider config", async () => {
    await seedProject();
    await store.upsertProviderConfig({ providerId: "cloudflare" });
    await store.deleteProviderConfig("cloudflare");
    expect(await store.listProviderConfigs()).toHaveLength(0);
  });
});

describe("model catalog (PRD §8: cached locally with a refresh timestamp)", () => {
  it("upserts entries and refreshes the timestamp on conflict", async () => {
    await seedProject();
    await store.upsertModelCatalog([
      {
        id: newId("catalogEntry"),
        providerId: "vercel",
        modelId: "veo-3",
        displayName: "Veo 3",
        modality: "video",
        capabilities: { modes: ["text-to-video"] },
        pricing: { unit: "per-second", amount: 0.35, currency: "USD" },
        fetchedAt: NOW,
        isStale: false,
      },
    ]);

    await store.upsertModelCatalog([
      {
        id: newId("catalogEntry"),
        providerId: "vercel",
        modelId: "veo-3",
        displayName: "Veo 3 (updated)",
        modality: "video",
        capabilities: { modes: ["text-to-video", "image-to-video"] },
        pricing: null,
        fetchedAt: "2026-01-02T00:00:00.000Z",
        isStale: true,
      },
    ]);

    const entries = await store.listModelCatalog("vercel");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.displayName).toBe("Veo 3 (updated)");
    expect(entries[0]!.capabilities).toEqual({ modes: ["text-to-video", "image-to-video"] });
    expect(entries[0]!.pricing).toBeNull();
    expect(entries[0]!.isStale).toBe(true);
  });

  it("lists the whole catalog or a single provider", async () => {
    await seedProject();
    for (const providerId of ["vercel", "elevenlabs"]) {
      await store.upsertModelCatalog([
        {
          id: newId("catalogEntry"),
          providerId,
          modelId: "m1",
          displayName: "M1",
          modality: "image",
          capabilities: {},
          pricing: null,
          fetchedAt: NOW,
          isStale: false,
        },
      ]);
    }
    expect(await store.listModelCatalog()).toHaveLength(2);
    expect(await store.listModelCatalog("elevenlabs")).toHaveLength(1);
  });
});

describe("spend ledger (PRD §13: daily budget ceiling)", () => {
  it("records estimates and actuals and sums them by day", async () => {
    await seedProject();
    await store.recordSpend({
      id: newId("spend"),
      projectId: PROJECT_ID,
      jobId: null,
      providerId: "vercel",
      amount: 1.25,
      currency: "USD",
      kind: "estimate",
      day: "2026-01-01",
      createdAt: NOW,
    });
    await store.recordSpend({
      id: newId("spend"),
      projectId: PROJECT_ID,
      jobId: null,
      providerId: "elevenlabs",
      amount: 0.75,
      currency: "USD",
      kind: "actual",
      day: "2026-01-01",
      createdAt: NOW,
    });
    await store.recordSpend({
      id: newId("spend"),
      projectId: PROJECT_ID,
      jobId: null,
      providerId: "vercel",
      amount: 9,
      currency: "USD",
      kind: "actual",
      day: "2026-01-02",
      createdAt: NOW,
    });

    const today = await store.listSpend({ day: "2026-01-01" });
    expect(today).toHaveLength(2);
    expect(today.reduce((sum, entry) => sum + entry.amount, 0)).toBeCloseTo(2, 6);
    expect(await store.listSpend({ day: "2026-01-02" })).toHaveLength(1);
  });
});

describe("settings", () => {
  it("round-trips structured values and overwrites in place", async () => {
    await store.setSetting("budget", { maxCostPerJob: 5, currency: "USD" });
    expect(await store.getSetting("budget")).toEqual({ maxCostPerJob: 5, currency: "USD" });

    await store.setSetting("budget", { maxCostPerJob: 8, currency: "USD" });
    expect(await store.getSetting("budget")).toEqual({ maxCostPerJob: 8, currency: "USD" });
    expect(await store.allSettings()).toEqual({ budget: { maxCostPerJob: 8, currency: "USD" } });
  });

  it("returns undefined for an unset key", async () => {
    expect(await store.getSetting("missing")).toBeUndefined();
  });
});

describe("persistence on disk", () => {
  it("writes a real database file that reopens with the same content", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const directory = await mkdtemp(join(tmpdir(), "creativelab-db-"));
    const filename = join(directory, "project.db");

    try {
      const first = new SqliteProjectStore({ filename, migrations });
      await first.init();
      const document = await first.createProject({
        id: PROJECT_ID,
        title: "On disk",
        fps: { num: 25, den: 1 },
        width: 1080,
        height: 1920,
        createdAt: NOW,
      });
      const clip = makeClip(document, 0, 25);
      await first.saveDocument({ ...document, clips: [clip] });
      expect(first.driver.integrityCheck()).toBe("ok");
      await first.close();

      const second = new SqliteProjectStore({ filename, migrations });
      await second.init();
      const reloaded = await second.loadDocument();
      expect(reloaded.project.title).toBe("On disk");
      expect(reloaded.project.fps).toEqual({ num: 25, den: 1 });
      expect(reloaded.clips).toHaveLength(1);
      expect(reloaded.clips[0]!.properties.transform.opacity).toBe(0.5);
      await second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
