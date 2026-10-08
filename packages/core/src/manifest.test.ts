import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifest,
  GENERATOR_ID,
  ManifestError,
  manifestToDocument,
  manifestsEquivalent,
  parseManifest,
  readManifest,
  serializeManifest,
  verifyAssets,
  writeManifest,
} from "../src/manifest.js";
import {
  AssetSchema,
  MANIFEST_VERSION,
  ProjectSchema,
  type Asset,
  type EditorDocument,
} from "../src/schema.js";
import { createInitialDocument } from "../src/timeline.js";
import { newId } from "../src/ids.js";
import { openWorkspace } from "../src/workspace.js";

const NOW = "2026-01-01T00:00:00.000Z";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "creativelab-manifest-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeDocument(): EditorDocument {
  const project = ProjectSchema.parse({
    id: "prj_manifest00000000000001",
    schemaVersion: 1,
    title: "Manifest fixture",
    fps: { num: 24000, den: 1001 },
    width: 1080,
    height: 1920,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const document = createInitialDocument(project);
  const track = document.tracks.find((candidate) => candidate.kind === "video")!;
  const clip = {
    id: newId("clip"),
    trackId: track.id,
    sequenceId: track.sequenceId,
    assetId: null,
    label: "shot-1",
    startFrame: 12,
    sourceInFrame: 4,
    durationFrames: 48,
    properties: {
      transform: {
        x: 3,
        y: -7,
        scale: 1.5,
        rotation: 90,
        opacity: 0.25,
        flipX: true,
        flipY: false,
      },
      crop: { top: 0.1, right: 0, bottom: 0, left: 0.05 },
      audio: { gainDb: -3, fadeInFrames: 6, fadeOutFrames: 6, enabled: true, pan: 0.2 },
      speed: { num: 2, den: 1 },
      transitionIn: { kind: "dip-to-black", durationFrames: 8 },
      transitionOut: { kind: "none", durationFrames: 0 },
      notes: "opening",
    },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...document, clips: [clip as EditorDocument["clips"][number]] };
}

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return AssetSchema.parse({
    id: newId("asset"),
    projectId: "prj_manifest00000000000001",
    mediaType: "video",
    uri: "/tmp/clip.mp4",
    relativePath: "assets/originals/clip.mp4",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe("buildManifest (PRD §11: project.json)", () => {
  it("captures the project, timeline and assets with a generator stamp", () => {
    const manifest = buildManifest(makeDocument(), new Date(NOW));

    expect(manifest.manifestVersion).toBe(MANIFEST_VERSION);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.generator).toBe(GENERATOR_ID);
    expect(manifest.exportedAt).toBe(NOW);
    expect(manifest.clips).toHaveLength(1);
    expect(manifest.tracks.length).toBeGreaterThanOrEqual(8);
  });

  it("preserves the NTSC rational frame rate exactly", () => {
    expect(buildManifest(makeDocument(), new Date(NOW)).project.fps).toEqual({
      num: 24000,
      den: 1001,
    });
  });

  it("round-trips through the document shape without loss", () => {
    const document = makeDocument();
    const restored = manifestToDocument(buildManifest(document, new Date(NOW)));

    expect(restored.project).toEqual(document.project);
    expect(restored.sequences).toEqual(document.sequences);
    expect(restored.tracks).toEqual(document.tracks);
    expect(restored.clips).toEqual(document.clips);
    // The manifest path is the portability contract; a deep-equal is the assertion.
    expect(restored.clips[0]!.properties.transform.scale).toBe(1.5);
    expect(restored.clips[0]!.properties.crop.left).toBe(0.05);
    expect(restored.clips[0]!.properties.speed).toEqual({ num: 2, den: 1 });
  });
});

describe("serialize / parse", () => {
  it("emits stable, human-readable JSON that parses back identically", () => {
    const manifest = buildManifest(makeDocument(), new Date(NOW));
    const text = serializeManifest(manifest);

    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "manifestVersion"');
    expect(parseManifest(text)).toEqual(manifest);
  });

  it("reports a syntax error precisely", () => {
    expect(() => parseManifest("{ not json")).toThrow(ManifestError);
    expect(() => parseManifest("{ not json")).toThrow(/not valid JSON/i);
  });

  it("names the offending field when validation fails", () => {
    const manifest = buildManifest(makeDocument(), new Date(NOW)) as unknown as Record<
      string,
      unknown
    >;
    const broken = {
      ...manifest,
      project: { ...(manifest["project"] as object), fps: { num: 0, den: 1 } },
    };
    try {
      parseManifest(JSON.stringify(broken));
      throw new Error("expected parseManifest to reject a zero frame-rate numerator");
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestError);
      expect((error as ManifestError).message).toMatch(/project\.fps\.num/);
      expect((error as ManifestError).issues.length).toBeGreaterThan(0);
    }
  });

  it("rejects a manifest missing required top-level fields", () => {
    expect(() => parseManifest(JSON.stringify({ manifestVersion: 1 }))).toThrow(ManifestError);
  });

  it("rejects a clip whose duration is not a positive integer", () => {
    const manifest = buildManifest(makeDocument(), new Date(NOW)) as unknown as Record<
      string,
      unknown
    >;
    const clips = (manifest["clips"] as Array<Record<string, unknown>>).map((clip) => ({
      ...clip,
      durationFrames: 0,
    }));
    expect(() => parseManifest(JSON.stringify({ ...manifest, clips }))).toThrow(ManifestError);
  });
});

describe("readManifest / writeManifest", () => {
  it("writes atomically and reads back", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    const manifest = buildManifest(makeDocument(), new Date(NOW));
    await writeManifest(workspace.layout.manifestPath, manifest);

    const text = await readFile(workspace.layout.manifestPath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(await readManifest(workspace.layout.manifestPath)).toEqual(manifest);
  });

  it("surfaces a missing file as an I/O error, not a validation error", async () => {
    await expect(readManifest(join(root, "absent", "project.json"))).rejects.toThrow();
  });
});

describe("manifestsEquivalent", () => {
  it("ignores timestamp-only differences", () => {
    const document = makeDocument();
    const a = buildManifest(document, new Date(NOW));
    const b = buildManifest(
      { ...document, project: { ...document.project, updatedAt: "2027-01-01T00:00:00.000Z" } },
      new Date("2027-05-05T00:00:00.000Z"),
    );
    expect(manifestsEquivalent(a, b)).toBe(true);
  });

  it("detects a real timeline change", () => {
    const document = makeDocument();
    const a = buildManifest(document, new Date(NOW));
    const moved = {
      ...document,
      clips: [{ ...document.clips[0]!, startFrame: document.clips[0]!.startFrame + 1 }],
    };
    expect(manifestsEquivalent(a, buildManifest(moved, new Date(NOW)))).toBe(false);
  });

  it("detects an added asset", () => {
    const document = makeDocument();
    const a = buildManifest(document, new Date(NOW));
    const withAsset = { ...document, assets: [makeAsset()] };
    expect(manifestsEquivalent(a, buildManifest(withAsset, new Date(NOW)))).toBe(false);
  });
});

describe("verifyAssets portability classification (PRD §11)", () => {
  it("is portable when every asset is inside the project", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    await writeFile(join(workspace.originalsDir(), "clip.mp4"), "media");
    const asset = makeAsset();

    const report = await verifyAssets(workspace.layout.root, [asset]);
    expect(report).toMatchObject({ checked: 1, ok: 1, portable: true });
    expect(report.issues).toEqual([]);
  });

  it("is not portable when a remote original is referenced", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    const remote = makeAsset({ relativePath: null, uri: "https://example.test/out.mp4" });

    const report = await verifyAssets(workspace.layout.root, [remote]);
    expect(report.portable).toBe(false);
    expect(report.issues[0]).toMatchObject({ kind: "not-packaged" });
    expect(report.issues[0]!.message).toMatch(/package the project/i);
  });

  it("reports a project-relative asset whose file was deleted as missing", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    const asset = makeAsset({ relativePath: "assets/originals/deleted.mp4" });

    const report = await verifyAssets(workspace.layout.root, [asset]);
    expect(report.portable).toBe(false);
    expect(report.issues[0]).toMatchObject({
      kind: "missing",
      relativePath: "assets/originals/deleted.mp4",
    });
  });

  it("classifies every asset independently", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    await writeFile(join(workspace.originalsDir(), "ok.mp4"), "media");
    const outside = join(root, "outside.mp4");
    await writeFile(outside, "media");

    const report = await verifyAssets(workspace.layout.root, [
      makeAsset({ relativePath: "assets/originals/ok.mp4" }),
      makeAsset({ relativePath: "assets/originals/gone.mp4" }),
      makeAsset({ relativePath: null, uri: outside, storageMode: "linked" }),
      makeAsset({ relativePath: null, uri: "https://example.test/x.mp4" }),
    ]);

    expect(report.checked).toBe(4);
    expect(report.ok).toBe(1);
    expect(report.issues.map((issue) => issue.kind)).toEqual([
      "missing",
      "not-packaged",
      "not-packaged",
    ]);
    expect(report.portable).toBe(false);
  });

  it("is trivially portable with no assets", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    expect(await verifyAssets(workspace.layout.root, [])).toMatchObject({
      checked: 0,
      ok: 0,
      portable: true,
    });
  });
});
