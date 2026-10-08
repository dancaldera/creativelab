/**
 * Mock bridge tests.
 *
 * The mock is the only reason the UI runs in a plain browser, so it has to satisfy the frozen
 * `StudioBridge` contract for real: create → import → job list → render progress → settings
 * round-trip, plus the security invariant that a credential response never contains the
 * secret.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { StudioBridge } from "./protocol";
import { IPC_COMMANDS } from "./protocol";
import {
  MockStudioBridge,
  advanceMockRenderClock,
  buildPeaks,
  buildThumbnailDataUri,
  resetMockState,
} from "./mock";

const SECRET = "sk-live-DO-NOT-LEAK-9f8e7d6c5b4a";
const WORKSPACE = "/Users/studio/CreativeLab/Mock Test";

let bridge: MockStudioBridge;

beforeEach(() => {
  resetMockState();
  bridge = new MockStudioBridge();
});

describe("MockStudioBridge: protocol conformance", () => {
  it("implements every method of the frozen StudioBridge interface", () => {
    // Compile-time proof plus a runtime sweep so a renamed method is caught here too.
    const asInterface: StudioBridge = bridge;
    const required = [
      "projectCreate",
      "projectOpen",
      "projectSave",
      "projectClose",
      "projectListRecent",
      "projectPackage",
      "projectBackup",
      "workspaceUsage",
      "workspacePurgeCaches",
      "assetImport",
      "assetRelink",
      "assetProbe",
      "assetDelete",
      "mediaThumbnail",
      "mediaWaveform",
      "mediaProxy",
      "renderStart",
      "renderStatus",
      "renderCancel",
      "credentialSet",
      "credentialDelete",
      "credentialList",
      "credentialTest",
      "providerListModels",
      "providerCatalogRefresh",
      "jobList",
      "jobCancel",
      "jobRetry",
      "jobReconcile",
      "dialogOpenFile",
      "dialogOpenDirectory",
      "dialogSaveFile",
      "settingsGet",
      "settingsSet",
    ];
    expect(required).toHaveLength(IPC_COMMANDS.length);
    for (const method of required) {
      expect(typeof (asInterface as unknown as Record<string, unknown>)[method]).toBe("function");
    }
    expect(bridge.kind).toBe("mock");
  });
});

describe("MockStudioBridge: project lifecycle", () => {
  it("creates an FR-03 starter document: 3 video, 4 audio and 1 caption track", async () => {
    const session = await bridge.projectCreate({
      title: "Mock Test",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      workspacePath: WORKSPACE,
    });
    expect(session.workspacePath).toBe(WORKSPACE);
    expect(session.recovery).toBeNull();
    expect(session.document.sequences).toHaveLength(1);
    expect(session.document.tracks.filter((track) => track.kind === "video")).toHaveLength(3);
    expect(session.document.tracks.filter((track) => track.kind === "audio")).toHaveLength(4);
    expect(session.document.tracks.filter((track) => track.kind === "caption")).toHaveLength(1);
    expect(session.document.clips).toHaveLength(0);
    expect(session.document.project.title).toBe("Mock Test");
    expect(session.document.project.fps).toEqual({ num: 30, den: 1 });
  });

  it("keeps state across bridge calls (the singleton survives re-renders)", async () => {
    await bridge.projectCreate({
      title: "A",
      fps: { num: 25, den: 1 },
      width: 1920,
      height: 1080,
      workspacePath: WORKSPACE,
    });
    await bridge.assetImport({
      workspacePath: WORKSPACE,
      sourcePaths: ["/tmp/clip.mp4"],
      mode: "copy",
    });
    // A *second* bridge instance is what `getBridge()` would return after a hot reload.
    const second = new MockStudioBridge();
    const session = await second.projectOpen({ workspacePath: WORKSPACE });
    expect(session.document.assets).toHaveLength(1);
  });

  it("round-trips a save and reports the counts", async () => {
    const session = await bridge.projectCreate({
      title: "Save test",
      fps: { num: 30, den: 1 },
      width: 1080,
      height: 1920,
      workspacePath: WORKSPACE,
    });
    const response = await bridge.projectSave({ document: session.document });
    expect(response.tracks).toBe(8);
    expect(response.clips).toBe(0);
    expect(Date.parse(response.savedAt)).not.toBeNaN();
    expect(response.schemaVersion).toBe(1);
  });

  it("lists the project it just created as recent", async () => {
    await bridge.projectCreate({
      title: "Recent",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      workspacePath: WORKSPACE,
    });
    const recent = await bridge.projectListRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.title).toBe("Recent");
    expect(recent[0]!.workspacePath).toBe(WORKSPACE);
  });

  it("refuses to save or import before a project exists", async () => {
    await expect(
      bridge.assetImport({ workspacePath: WORKSPACE, sourcePaths: ["/tmp/a.mp4"], mode: "copy" }),
    ).rejects.toThrow(/create or open/i);
  });
});

describe("MockStudioBridge: asset import", () => {
  beforeEach(async () => {
    await bridge.projectCreate({
      title: "Import",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      workspacePath: WORKSPACE,
    });
  });

  it("imports a synthetic asset with probed-looking metadata", async () => {
    const response = await bridge.assetImport({
      workspacePath: WORKSPACE,
      sourcePaths: ["/Users/studio/footage/interview.mp4"],
      mode: "copy",
    });
    expect(response.errors).toHaveLength(0);
    expect(response.imported).toHaveLength(1);
    const entry = response.imported[0]!;
    expect(entry.asset.mediaType).toBe("video");
    expect(entry.asset.storageMode).toBe("copied");
    expect(entry.asset.origin).toBe("imported");
    expect(entry.asset.relativePath).toContain("assets/originals/");
    expect(entry.asset.width).toBe(1920);
    expect(entry.asset.height).toBe(1080);
    expect(entry.asset.durationFrames).toBeGreaterThan(0);
    expect(entry.asset.sha256).toHaveLength(64);
    expect(entry.duplicateOf).toBeNull();
  });

  it("classifies each media type from its extension", async () => {
    const response = await bridge.assetImport({
      workspacePath: WORKSPACE,
      sourcePaths: ["/tmp/a.png", "/tmp/b.wav", "/tmp/c.srt", "/tmp/d.mov"],
      mode: "copy",
    });
    expect(response.imported.map((entry) => entry.asset.mediaType)).toEqual([
      "image",
      "audio",
      "subtitle",
      "video",
    ]);
  });

  it("detects a duplicate by content hash (FR-02)", async () => {
    const first = await bridge.assetImport({
      workspacePath: WORKSPACE,
      sourcePaths: ["/tmp/same.mp4"],
      mode: "copy",
    });
    const second = await bridge.assetImport({
      workspacePath: WORKSPACE,
      sourcePaths: ["/tmp/same.mp4"],
      mode: "copy",
    });
    expect(second.imported[0]!.duplicateOf).toBe(first.imported[0]!.asset.id);
  });

  it("records an explicit link mode and warns that the project is not portable", async () => {
    const response = await bridge.assetImport({
      workspacePath: WORKSPACE,
      sourcePaths: ["/tmp/linked.mp4"],
      mode: "link",
    });
    expect(response.imported[0]!.asset.storageMode).toBe("linked");
    expect(response.imported[0]!.asset.relativePath).toBeNull();
    expect(response.imported[0]!.warnings.join(" ")).toMatch(/not self-contained/i);

    const packaged = await bridge.projectPackage({ destinationPath: `${WORKSPACE}/exports/pkg` });
    expect(packaged.portable).toBe(false);
    expect(packaged.unresolved).toHaveLength(1);
  });

  it("exposes imported assets through a later projectOpen", async () => {
    await bridge.assetImport({
      workspacePath: WORKSPACE,
      sourcePaths: ["/tmp/one.mp4", "/tmp/two.mp4"],
      mode: "copy",
    });
    const session = await bridge.projectOpen({ workspacePath: WORKSPACE });
    expect(session.document.assets).toHaveLength(2);
  });
});

describe("MockStudioBridge: derived media", () => {
  let assetId: string;

  beforeEach(async () => {
    await bridge.projectCreate({
      title: "Media",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      workspacePath: WORKSPACE,
    });
    const imported = await bridge.assetImport({
      workspacePath: WORKSPACE,
      sourcePaths: ["/tmp/take.mp4"],
      mode: "copy",
    });
    assetId = imported.imported[0]!.asset.id;
  });

  it("returns a resolvable thumbnail without touching the filesystem", async () => {
    const thumbnail = await bridge.mediaThumbnail({
      workspacePath: WORKSPACE,
      assetId,
      atSeconds: 1.5,
      width: 160,
    });
    // In a DOM (webview/browser) this is a PNG data URI; in the node test run the canvas is
    // unavailable and the generator falls back to a 1x1 transparent PNG — still resolvable.
    expect(thumbnail.relativePath.startsWith("data:image/png;base64,")).toBe(true);
    expect(thumbnail.width).toBe(160);
    expect(thumbnail.height).toBeGreaterThan(0);
  });

  it("returns a plausible waveform with interleaved min/max pairs", async () => {
    const waveform = await bridge.mediaWaveform({ workspacePath: WORKSPACE, assetId, buckets: 64 });
    expect(waveform.buckets).toBe(64);
    expect(waveform.peaks).toHaveLength(64);
    for (const pair of waveform.peaks) {
      expect(pair).toHaveLength(2);
      const [min, max] = pair as [number, number];
      expect(min).toBeGreaterThanOrEqual(-1);
      expect(max).toBeLessThanOrEqual(1);
      expect(min).toBeLessThanOrEqual(max);
    }
  });

  it("is deterministic for the same asset and bucket count", async () => {
    const first = await bridge.mediaWaveform({ workspacePath: WORKSPACE, assetId, buckets: 32 });
    const second = await bridge.mediaWaveform({ workspacePath: WORKSPACE, assetId, buckets: 32 });
    expect(first.peaks).toEqual(second.peaks);
    expect(buildPeaks("seed", 4)).toEqual(buildPeaks("seed", 4));
  });

  it("clamps the bucket count instead of allocating an unbounded array", async () => {
    const huge = await bridge.mediaWaveform({
      workspacePath: WORKSPACE,
      assetId,
      buckets: 1_000_000,
    });
    expect(huge.buckets).toBe(2048);
    const tiny = await bridge.mediaWaveform({ workspacePath: WORKSPACE, assetId, buckets: 0 });
    expect(tiny.buckets).toBe(1);
  });

  it("returns a smaller proxy and relinks a missing asset", async () => {
    const proxy = await bridge.mediaProxy({ workspacePath: WORKSPACE, assetId, maxWidth: 960 });
    expect(proxy.width).toBe(960);
    expect(proxy.height).toBe(540);
    expect(proxy.relativePath).toContain("cache/proxies/");

    const relinked = await bridge.assetRelink({
      workspacePath: WORKSPACE,
      assetId,
      newPath: "/Volumes/Raid/take.mp4",
    });
    expect(relinked.uri).toBe("/Volumes/Raid/take.mp4");
    expect(relinked.missingAt).toBeNull();
  });

  it("rejects unknown asset ids rather than inventing a result", async () => {
    await expect(
      bridge.mediaThumbnail({
        workspacePath: WORKSPACE,
        assetId: "ast_missing",
        atSeconds: 0,
        width: 64,
      }),
    ).rejects.toThrow(/unknown asset/i);
  });
});

describe("MockStudioBridge: jobs and render progress", () => {
  beforeEach(async () => {
    await bridge.projectCreate({
      title: "Jobs",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      workspacePath: WORKSPACE,
    });
  });

  it("lists jobs filtered by status, newest first", async () => {
    bridge.seedJob({
      providerId: "vercel-gateway",
      modelId: "m/a",
      modality: "video",
      mode: "text-to-video",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    bridge.seedJob({
      providerId: "elevenlabs",
      modelId: "m/b",
      modality: "audio",
      mode: "tts",
      status: "failed",
      createdAt: "2026-01-02T00:00:00.000Z",
    });

    const all = await bridge.jobList({ workspacePath: WORKSPACE });
    expect(all.jobs).toHaveLength(2);
    expect(all.jobs[0]!.modelId).toBe("m/b");

    const failed = await bridge.jobList({ workspacePath: WORKSPACE, status: ["failed"] });
    expect(failed.jobs.map((job) => job.modelId)).toEqual(["m/b"]);

    const limited = await bridge.jobList({ workspacePath: WORKSPACE, limit: 1 });
    expect(limited.jobs).toHaveLength(1);
  });

  it("cancels a running job and refuses to cancel a finished one", async () => {
    const job = bridge.seedJob({
      providerId: "p",
      modelId: "m",
      modality: "image",
      mode: "text-to-image",
      status: "running",
    });
    await bridge.jobCancel({ workspacePath: WORKSPACE, jobId: job.id });
    const after = await bridge.jobList({ workspacePath: WORKSPACE });
    expect(after.jobs[0]!.status).toBe("canceled");
    await expect(bridge.jobCancel({ workspacePath: WORKSPACE, jobId: job.id })).rejects.toThrow(
      /already canceled/i,
    );
  });

  it("retries only failed jobs and bumps the attempt counter", async () => {
    const failed = bridge.seedJob({
      providerId: "p",
      modelId: "m",
      modality: "video",
      mode: "text-to-video",
      status: "failed",
      retryCount: 1,
    });
    await bridge.jobRetry({ workspacePath: WORKSPACE, jobId: failed.id });
    const [retried] = (await bridge.jobList({ workspacePath: WORKSPACE })).jobs;
    expect(retried!.status).toBe("queued");
    expect(retried!.retryCount).toBe(2);
    expect(retried!.error).toBeNull();

    const running = bridge.seedJob({
      providerId: "p",
      modelId: "m2",
      modality: "video",
      mode: "text-to-video",
      status: "running",
    });
    await expect(bridge.jobRetry({ workspacePath: WORKSPACE, jobId: running.id })).rejects.toThrow(
      /only failed/i,
    );
  });

  it("parks an unknown job with no provider id for a human decision and never resubmits it", async () => {
    bridge.seedJob({
      providerId: "p",
      modelId: "m1",
      modality: "video",
      mode: "text-to-video",
      status: "unknown",
      providerJobId: null,
    });
    bridge.seedJob({
      providerId: "p",
      modelId: "m2",
      modality: "video",
      mode: "text-to-video",
      status: "unknown",
      providerJobId: "remote-42",
    });

    const reconcile = await bridge.jobReconcile({ workspacePath: WORKSPACE });
    expect(reconcile.needsAttention).toHaveLength(1);
    expect(reconcile.needsAttention[0]!.reason).toMatch(/unverified/i);
    expect(reconcile.resumed).toHaveLength(1);
  });

  it("reports monotonically increasing render progress up to completion", async () => {
    const imported = await bridge.assetImport({
      workspacePath: WORKSPACE,
      sourcePaths: ["/tmp/r.mp4"],
      mode: "copy",
    });
    void imported;
    const session = await bridge.projectOpen({ workspacePath: WORKSPACE });
    const sequenceId = session.document.sequences[0]!.id;

    const started = await bridge.renderStart({
      workspacePath: WORKSPACE,
      sequenceId,
      presetId: "1080p",
      outputPath: `${WORKSPACE}/exports/out.mp4`,
      burnInCaptions: true,
    });
    expect(started.totalFrames).toBeGreaterThan(0);

    const first = await bridge.renderStatus({
      workspacePath: WORKSPACE,
      exportJobId: started.exportJobId,
    });
    expect(["preparing", "rendering", "finalizing", "completed"]).toContain(first.status);
    expect(first.progress).toBeGreaterThanOrEqual(0);
    expect(first.logTail.join("\n")).toContain("ffmpeg version");
    expect(first.outputPath).toBe(`${WORKSPACE}/exports/out.mp4`);

    // Progress is derived from elapsed time, so moving the recorded start time into the past
    // is a deterministic way to prove it actually advances without sleeping in the test.
    advanceMockRenderClock(started.exportJobId, 10_000);
    const later = await bridge.renderStatus({
      workspacePath: WORKSPACE,
      exportJobId: started.exportJobId,
    });
    expect(later.progress).toBeGreaterThan(first.progress);
    expect(later.renderedFrames).toBeGreaterThan(first.renderedFrames);
    expect(later.renderedFrames).toBeLessThanOrEqual(later.totalFrames);

    // Push well past the simulated render duration: it must reach a terminal state and clamp.
    advanceMockRenderClock(started.exportJobId, 10 * 60_000);
    const done = await bridge.renderStatus({
      workspacePath: WORKSPACE,
      exportJobId: started.exportJobId,
    });
    expect(done.status).toBe("completed");
    expect(done.progress).toBe(1);
    expect(done.renderedFrames).toBe(done.totalFrames);
    expect(done.errors).toHaveLength(0);
  });

  it("supports canceling a render and reports the canceled status", async () => {
    const session = await bridge.projectOpen({ workspacePath: WORKSPACE });
    const started = await bridge.renderStart({
      workspacePath: WORKSPACE,
      sequenceId: session.document.sequences[0]!.id,
      presetId: "720p",
      outputPath: `${WORKSPACE}/exports/cancel.mp4`,
    });
    await bridge.renderCancel({ exportJobId: started.exportJobId });
    const status = await bridge.renderStatus({
      workspacePath: WORKSPACE,
      exportJobId: started.exportJobId,
    });
    expect(status.status).toBe("canceled");
    expect(status.errors).toHaveLength(0);
  });

  it("rejects an unknown export job id", async () => {
    await expect(
      bridge.renderStatus({ workspacePath: WORKSPACE, exportJobId: "exp_nope" }),
    ).rejects.toThrow(/unknown export job/i);
  });
});

describe("MockStudioBridge: provider catalog", () => {
  it("returns a small built-in catalog with capabilities and pricing", async () => {
    const response = await bridge.providerListModels({});
    expect(response.models.length).toBeGreaterThanOrEqual(5);
    expect(response.errors).toHaveLength(0);
    const modalities = new Set(response.models.map((model) => model.modality));
    for (const expected of ["image", "video", "audio", "subtitle"]) {
      expect(modalities.has(expected)).toBe(true);
    }
    const video = response.models.find((model) => model.modelId === "google/veo-3")!;
    expect(video.capabilities["supportsNegativePrompt"]).toBe(true);
    expect(video.capabilities["durationMaxSeconds"]).toBeGreaterThan(0);
    expect(video.providerId).toBe("vercel-gateway");
    expect(Date.parse(response.fetchedAt)).not.toBeNaN();
  });

  it("filters by provider and refreshes the fetched-at stamp", async () => {
    const eleven = await bridge.providerListModels({ providerId: "elevenlabs" });
    expect(eleven.models.every((model) => model.providerId === "elevenlabs")).toBe(true);

    const refreshed = await bridge.providerCatalogRefresh({ providerId: "elevenlabs" });
    expect(refreshed.fetchedAt >= eleven.fetchedAt).toBe(true);
  });
});

describe("MockStudioBridge: settings round-trip", () => {
  it("returns null for an unknown key and the stored value afterwards", async () => {
    expect((await bridge.settingsGet({ key: "ui.workspace.v1" })).value).toBeNull();

    const payload = {
      activePanel: "generate",
      sizes: { leftRail: 300, inspector: 360, timeline: 280 },
      layouts: [],
    };
    await bridge.settingsSet({ key: "ui.workspace.v1", value: payload });
    expect((await bridge.settingsGet({ key: "ui.workspace.v1" })).value).toEqual(payload);
  });

  it("round-trips falsy values without coercing them to null", async () => {
    for (const value of [0, false, "", [], {}]) {
      await bridge.settingsSet({ key: "k", value });
      expect((await bridge.settingsGet({ key: "k" })).value).toEqual(value);
    }
  });
});

describe("MockStudioBridge: credentials never leak the secret", () => {
  it("returns only a ref and a hasSecret flag from credentialSet", async () => {
    const reference = await bridge.credentialSet({ providerId: "vercel-gateway", secret: SECRET });
    expect(reference.hasSecret).toBe(true);
    expect(reference.credentialRef).toBe("keychain://creativelab/vercel-gateway");
    // The whole response object, serialized, must not contain the secret.
    expect(JSON.stringify(reference)).not.toContain(SECRET);
    expect(reference.credentialRef).not.toContain(SECRET);
  });

  it("never includes the secret in credentialList, credentialTest or an error", async () => {
    await bridge.credentialSet({ providerId: "elevenlabs", secret: SECRET });

    const list = await bridge.credentialList();
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(list).toEqual([
      {
        providerId: "elevenlabs",
        credentialRef: "keychain://creativelab/elevenlabs",
        hasSecret: true,
      },
    ]);
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual(["credentialRef", "hasSecret", "providerId"]);
    }

    const test = await bridge.credentialTest({ providerId: "elevenlabs" });
    expect(test.ok).toBe(true);
    expect(JSON.stringify(test)).not.toContain(SECRET);
    // Not even a hint of the value: no length, no prefix, no suffix.
    expect(test.message).not.toContain(SECRET.slice(0, 6));
    expect(test.message).not.toMatch(/\d{2,} char/);

    await expect(bridge.credentialSet({ providerId: "empty", secret: "   " })).rejects.toThrow();
    try {
      await bridge.credentialSet({ providerId: "empty", secret: "   " });
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
    }
  });

  it("stores the secret in memory only, retrievable solely by the test hook", async () => {
    await bridge.credentialSet({ providerId: "cloudflare-ai", secret: SECRET });
    // The private map is the one place the secret lives; no DTO exposes it.
    expect(bridge.__secretForTests("cloudflare-ai")).toBe(SECRET);
    const settings = await bridge.settingsGet({ key: "anything" });
    expect(JSON.stringify(settings)).not.toContain(SECRET);
  });

  it("reports a missing credential without inventing one", async () => {
    const result = await bridge.credentialTest({ providerId: "not-configured" });
    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBeNull();
    expect(result.message).toMatch(/no credential/i);
  });

  it("deletes a credential and reports hasSecret false afterwards", async () => {
    await bridge.credentialSet({ providerId: "vercel-gateway", secret: SECRET });
    await bridge.credentialDelete({ providerId: "vercel-gateway" });
    expect(await bridge.credentialList()).toHaveLength(0);
    expect(bridge.__secretForTests("vercel-gateway")).toBeUndefined();
  });
});

describe("MockStudioBridge: workspace usage and dialogs", () => {
  it("reports cache bytes as reclaimable and shrinks them after a purge", async () => {
    await bridge.projectCreate({
      title: "Usage",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      workspacePath: WORKSPACE,
    });
    const imported = await bridge.assetImport({
      workspacePath: WORKSPACE,
      sourcePaths: ["/tmp/u.mp4"],
      mode: "copy",
    });
    await bridge.mediaProxy({
      workspacePath: WORKSPACE,
      assetId: imported.imported[0]!.asset.id,
      maxWidth: 1280,
    });

    const usage = await bridge.workspaceUsage({ workspacePath: WORKSPACE });
    expect(usage.root).toBe(WORKSPACE);
    expect(usage.cacheBytes).toBeGreaterThan(0);
    expect(usage.cacheReclaimableBytes).toBeLessThanOrEqual(usage.cacheBytes);
    expect(usage.totalBytes).toBeGreaterThan(usage.cacheBytes);
    expect(usage.directories.length).toBeGreaterThan(0);

    const purged = await bridge.workspacePurgeCaches({ workspacePath: WORKSPACE });
    expect(purged.purged.length).toBeGreaterThan(0);
    const after = await bridge.workspaceUsage({ workspacePath: WORKSPACE });
    expect(after.cacheBytes).toBeLessThan(usage.cacheBytes);
  });

  it("returns plausible dialog results that the UI can act on", async () => {
    const files = await bridge.dialogOpenFile({ multiple: true });
    expect(files.canceled).toBe(false);
    expect(files.paths.length).toBeGreaterThan(0);
    const directory = await bridge.dialogOpenDirectory({ title: "Pick" });
    expect(directory.paths[0]).toContain("/");
    const save = await bridge.dialogSaveFile({ defaultPath: "/tmp/out.mp4" });
    expect(save.paths[0]).toBe("/tmp/out.mp4");
  });

  it("backs up the project with a labelled destination", async () => {
    await bridge.projectCreate({
      title: "Backup",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      workspacePath: WORKSPACE,
    });
    const backup = await bridge.projectBackup({ workspacePath: WORKSPACE, label: "manual" });
    expect(backup.destination).toContain("/backups/manual-");
    expect(backup.files).toBeGreaterThan(0);
  });
});

describe("buildThumbnailDataUri fallback", () => {
  it("returns a data URI or the documented transparent fallback, never throws", () => {
    const asset = {
      id: "ast_x",
      mediaType: "video" as const,
    } as unknown as Parameters<typeof buildThumbnailDataUri>[0];
    const uri = buildThumbnailDataUri(asset, 0);
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
  });
});
