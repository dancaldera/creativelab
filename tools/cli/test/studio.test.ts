import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DEFAULT_CLIP_PROPERTIES } from "@creativelab/core";

import {
  describeDocument,
  importAsset,
  initProject,
  isProtectedResetTarget,
  modalityForMode,
  modalityForPath,
  openProject,
  placeClip,
  resetWorkspace,
  tracksOfKind,
} from "../lib/studio.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "creativelab-cli-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => undefined));
}

describe("isProtectedResetTarget", () => {
  it("protects the filesystem root, top-level directories and this checkout", () => {
    expect(isProtectedResetTarget("/")).toBe(true);
    expect(isProtectedResetTarget("/Users")).toBe(true);
    expect(isProtectedResetTarget("/tmp")).toBe(true);
    // Deleting the working copy to satisfy `--force` would be catastrophic.
    expect(isProtectedResetTarget(REPO_ROOT)).toBe(true);
  });

  it("allows an ordinary project path", () => {
    expect(isProtectedResetTarget("/tmp/some-project")).toBe(false);
    expect(isProtectedResetTarget(join(REPO_ROOT, ".tmp", "e2e", "DemoProject"))).toBe(false);
    expect(isProtectedResetTarget(join(tmpdir(), "a", "b", "c"))).toBe(false);
  });

  it("resolves relative paths before deciding", () => {
    // `.` from the repo root *is* the repo root, so it must be protected.
    expect(isProtectedResetTarget(REPO_ROOT)).toBe(true);
  });
});

describe("resetWorkspace", () => {
  it("refuses to touch a directory that is not a project, leaving its files alone", async () => {
    const directory = join(root, "not-a-project");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "keep.txt"), "precious");

    // `--force` must not delete a stranger's folder just because the path was given.
    expect(await resetWorkspace(directory)).toBe(false);
    expect(await exists(join(directory, "keep.txt"))).toBe(true);
  });

  it("removes a directory that really is a project", async () => {
    const directory = join(root, "real-project");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "project.json"), "{}");
    await writeFile(join(directory, "keep.txt"), "media");

    expect(await resetWorkspace(directory)).toBe(true);
    expect(await exists(directory)).toBe(false);
  });

  it("recognises a project by its database even without a manifest", async () => {
    const directory = join(root, "db-only");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "project.db"), "");
    expect(await resetWorkspace(directory)).toBe(true);
    expect(await exists(directory)).toBe(false);
  });
});

describe("modality inference", () => {
  it("maps the supported extensions", () => {
    for (const extension of ["mp4", "mov", "webm", "mkv", "m4v"]) {
      expect(modalityForPath(`clip.${extension}`)).toBe("video");
    }
    for (const extension of ["png", "jpg", "jpeg", "webp"]) {
      expect(modalityForPath(`still.${extension}`)).toBe("image");
    }
    for (const extension of ["wav", "mp3", "m4a", "aac", "flac"]) {
      expect(modalityForPath(`sound.${extension}`)).toBe("audio");
    }
  });

  it("is case-insensitive and inspects only the final extension", () => {
    expect(modalityForPath("/tmp/My.Clip.FINAL.MP4")).toBe("video");
    expect(modalityForPath("archive.tar.wav")).toBe("audio");
  });

  it("fails loudly on an unsupported extension instead of guessing", () => {
    expect(() => modalityForPath("notes.txt")).toThrow(/unsupported media extension/i);
    expect(() => modalityForPath("noextension")).toThrow(/unsupported media extension/i);
  });

  it("maps generation modes to the modality the asset will be", () => {
    expect(modalityForMode("text-to-image")).toBe("image");
    expect(modalityForMode("image-to-video")).toBe("video");
    expect(modalityForMode("tts")).toBe("audio");
    expect(modalityForMode("sfx")).toBe("audio");
    expect(modalityForMode("music")).toBe("audio");
    expect(modalityForMode("transcription")).toBe("subtitle");
  });
});

describe("describeDocument", () => {
  it("reports the timeline span from the furthest clip end, not the last clip", async () => {
    const context = await initProject({
      directory: join(root, "report"),
      title: "Report",
      fps: { num: 25, den: 1 },
      width: 1280,
      height: 720,
    });
    const { session } = context;

    // Two clips on different tracks: the audio one extends further.
    const videoTrack = tracksOfKind(session.document, "video")[0];
    const audioTrack = tracksOfKind(session.document, "audio")[0];
    session.applyEdit("seed", (document) => ({
      ...document,
      clips: [
        {
          id: "clp_video0000000000000001",
          trackId: videoTrack.id,
          sequenceId: videoTrack.sequenceId,
          assetId: null,
          label: "v",
          startFrame: 0,
          sourceInFrame: 0,
          durationFrames: 50,
          properties: DEFAULT_CLIP_PROPERTIES,
          version: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "clp_audio0000000000000001",
          trackId: audioTrack.id,
          sequenceId: audioTrack.sequenceId,
          assetId: null,
          label: "a",
          startFrame: 0,
          sourceInFrame: 0,
          durationFrames: 125,
          properties: DEFAULT_CLIP_PROPERTIES,
          version: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }));

    const report = describeDocument(session.document);
    expect(report.durationFrames).toBe(125);
    expect(report.durationTimecode).toBe("00:00:05:00"); // 125 frames @ 25fps
    expect(report.fps).toBe("25/1");
    expect(report.resolution).toBe("1280x720");
    expect(report.clips).toBe(2);
    await session.close();
  });
});

describe("project lifecycle through the CLI helpers", () => {
  it("creates a project with the FR-03 track set and reopens it", async () => {
    const directory = join(root, "Lifecycle");
    const created = await initProject({
      directory,
      title: "Lifecycle",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
    });
    expect(created.session.document.tracks.filter((track) => track.kind === "video")).toHaveLength(
      3,
    );
    expect(created.session.document.tracks.filter((track) => track.kind === "audio")).toHaveLength(
      4,
    );
    expect(await exists(join(directory, "project.json"))).toBe(true);
    await created.session.close();

    const reopened = await openProject(directory);
    expect(reopened.session.document.project.title).toBe("Lifecycle");
    await reopened.session.close();
  });

  it("refuses to overwrite an existing project without --force", async () => {
    const directory = join(root, "Guarded");
    const first = await initProject({
      directory,
      title: "First",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
    });
    await first.session.close();

    await expect(
      initProject({
        directory,
        title: "Second",
        fps: { num: 30, den: 1 },
        width: 1920,
        height: 1080,
      }),
    ).rejects.toThrow(/already exists/i);

    // With --force it replaces rather than appending a second project.
    const second = await initProject({
      directory,
      title: "Second",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
      force: true,
    });
    expect(second.session.document.project.title).toBe("Second");
    expect(await second.store.listProjects()).toHaveLength(1);
    await second.session.close();
  });
});

describe("importAsset", () => {
  it("copies media in, records a content hash, and dedupes a repeat import", async () => {
    const directory = join(root, "Imports");
    const context = await initProject({
      directory,
      title: "Imports",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
    });

    // A real PNG, so probing succeeds without needing FFmpeg-generated video.
    const { encodePng } = await import("@creativelab/providers");
    const sourcePath = join(root, "still.png");
    await writeFile(sourcePath, encodePng({ width: 32, height: 24, rgb: [10, 20, 30] }));

    const first = await importAsset(context, sourcePath);
    expect(first.asset.mediaType).toBe("image");
    expect(first.asset.storageMode).toBe("copied");
    expect(first.asset.relativePath).toMatch(/^assets\/originals\//);
    expect(first.asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.duplicateOf).toBeNull();

    const filesBefore = (await readdir(context.workspace.originalsDir())).sort();
    const second = await importAsset(context, sourcePath);
    const filesAfter = (await readdir(context.workspace.originalsDir())).sort();

    expect(second.duplicateOf).toBe(first.asset.id);
    // The regression that motivated hashing the source first: a duplicate import used to
    // leave an unreferenced "(2)" copy on disk.
    expect(filesAfter).toEqual(filesBefore);

    await context.session.close();
  });

  it("links an original instead of copying when asked, and reports it as not portable", async () => {
    const directory = join(root, "Linked");
    const context = await initProject({
      directory,
      title: "Linked",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
    });

    const { encodePng } = await import("@creativelab/providers");
    const outside = join(root, "outside.png");
    await writeFile(outside, encodePng({ width: 16, height: 16, rgb: [1, 2, 3] }));

    const result = await importAsset(context, outside, { mode: "link" });
    expect(result.asset.storageMode).toBe("linked");
    expect(result.asset.relativePath).toBeNull();

    const report = await context.session.verifyAssets();
    expect(report.portable).toBe(false);
    expect(report.issues[0]?.kind).toBe("not-packaged");

    await context.session.close();
  });

  it("rejects a path that is not a readable file", async () => {
    const context = await initProject({
      directory: join(root, "Bad"),
      title: "Bad",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
    });
    await expect(importAsset(context, join(root, "missing.mp4"))).rejects.toThrow(
      /not a readable file/i,
    );
    await context.session.close();
  });
});

describe("placeClip", () => {
  it("appends a clip after the existing content on the chosen track", async () => {
    const directory = join(root, "Placing");
    const context = await initProject({
      directory,
      title: "Placing",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
    });

    const { encodePng } = await import("@creativelab/providers");
    const sourcePath = join(root, "frame.png");
    await writeFile(sourcePath, encodePng({ width: 64, height: 36, rgb: [90, 120, 200] }));
    const imported = await importAsset(context, sourcePath);

    const first = placeClip(context, { assetId: imported.asset.id });
    const second = placeClip(context, { assetId: imported.asset.id });

    // A still has no intrinsic duration, so the documented default (3 s) applies.
    expect(first.startFrame).toBe(0);
    expect(first.durationFrames).toBe(90);
    expect(second.startFrame).toBe(90);

    await context.session.close();
  });

  it("refuses an unknown asset instead of silently creating an empty clip", async () => {
    const context = await initProject({
      directory: join(root, "Unknown"),
      title: "Unknown",
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
    });
    expect(() => placeClip(context, { assetId: "ast_nope00000000000000" })).toThrow(
      /unknown asset/i,
    );
    await context.session.close();
  });
});
