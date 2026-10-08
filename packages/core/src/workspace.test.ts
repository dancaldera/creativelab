import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertInside,
  assertSafeRelativePath,
  atomicWriteFile,
  atomicWriteJson,
  createBackup,
  directoryUsage,
  fromProjectRelative,
  hashBytes,
  hashFile,
  isInside,
  makeWorkspace,
  openWorkspace,
  pathExists,
  planImportDestination,
  purgeCaches,
  readJsonFile,
  safeJoin,
  sanitizeFileName,
  toProjectRelative,
  uniqueFileName,
  UnsafePathError,
  workspaceUsage,
  WORKSPACE_DIRS,
} from "../src/workspace.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "creativelab-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("assertSafeRelativePath (PRD §13: scoped file permissions)", () => {
  it("accepts and normalizes legitimate project-relative paths", () => {
    expect(assertSafeRelativePath("assets/originals/clip.mp4")).toBe("assets/originals/clip.mp4");
    expect(assertSafeRelativePath("./assets//originals/./clip.mp4")).toBe(
      "assets/originals/clip.mp4",
    );
    expect(assertSafeRelativePath("project.json")).toBe("project.json");
  });

  it("rejects traversal in every spelling", () => {
    expect(() => assertSafeRelativePath("../secrets")).toThrow(UnsafePathError);
    expect(() => assertSafeRelativePath("assets/../../etc/passwd")).toThrow(UnsafePathError);
    expect(() => assertSafeRelativePath("a/b/../../../c")).toThrow(UnsafePathError);
    expect(() => assertSafeRelativePath("..")).toThrow(UnsafePathError);
  });

  it("rejects absolute paths, drive letters and UNC-style input", () => {
    expect(() => assertSafeRelativePath("/etc/passwd")).toThrow(UnsafePathError);
    expect(() => assertSafeRelativePath("C:/Windows/system32")).toThrow(UnsafePathError);
    expect(() => assertSafeRelativePath("C:\\Windows")).toThrow(UnsafePathError);
  });

  it("rejects backslashes, NUL bytes and control characters", () => {
    expect(() => assertSafeRelativePath("assets\\clip.mp4")).toThrow(/forward slashes/i);
    expect(() => assertSafeRelativePath("assets/clip\u0000.mp4")).toThrow(UnsafePathError);
    expect(() => assertSafeRelativePath("assets/clip\n.mp4")).toThrow(/control characters/i);
  });

  it("rejects empty and non-string input", () => {
    expect(() => assertSafeRelativePath("")).toThrow(UnsafePathError);
    expect(() => assertSafeRelativePath(undefined as unknown as string)).toThrow(UnsafePathError);
  });
});

describe("isInside / assertInside / safeJoin", () => {
  it("treats the root itself and its descendants as inside", () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, join(root, "assets", "originals"))).toBe(true);
  });

  it("rejects siblings and parents", () => {
    expect(isInside(root, resolve(root, ".."))).toBe(false);
    expect(isInside(root, `${root}-sibling`)).toBe(false);
    expect(() => assertInside(root, "../outside")).toThrow(UnsafePathError);
  });

  it("joins validated segments and refuses anything that escapes", () => {
    expect(safeJoin(root, "assets", "originals", "a.mp4")).toBe(
      join(root, "assets/originals/a.mp4"),
    );
    expect(() => safeJoin(root, "assets", "..", "..", "escape")).toThrow(UnsafePathError);
    expect(() => safeJoin(root, "/etc/passwd")).toThrow(UnsafePathError);
  });
});

describe("sanitizeFileName", () => {
  it("strips path separators and reserved characters", () => {
    expect(sanitizeFileName("my/clip:1?.mp4")).toBe("my-clip-1-.mp4");
    expect(sanitizeFileName("a\\b|c.mp4")).toBe("a-b-c.mp4");
  });

  it("removes control characters and leading dots", () => {
    expect(sanitizeFileName("..hidden.mp4")).toBe("hidden.mp4");
    expect(sanitizeFileName("bad\u0000name.mp4")).toBe("badname.mp4");
  });

  it("falls back for empty or whitespace-only names", () => {
    expect(sanitizeFileName("   ", "clip.mp4")).toBe("clip.mp4");
    expect(sanitizeFileName("...", "clip.mp4")).toBe("clip.mp4");
    expect(sanitizeFileName(".")).toBe("untitled");
  });

  it("escapes Windows reserved device names", () => {
    expect(sanitizeFileName("CON.mp4")).toBe("_CON.mp4");
    expect(sanitizeFileName("lpt1")).toBe("_lpt1");
  });

  it("caps the length while preserving the extension", () => {
    const long = `${"a".repeat(300)}.mp4`;
    const result = sanitizeFileName(long);
    expect(result.length).toBeLessThanOrEqual(180);
    expect(result.endsWith(".mp4")).toBe(true);
  });

  it("normalizes Unicode rather than mangling non-ASCII names", () => {
    expect(sanitizeFileName("café-日本語.mp4")).toBe("café-日本語.mp4");
  });
});

describe("uniqueFileName", () => {
  it("returns the desired name when it is free", () => {
    expect(uniqueFileName([], "clip.mp4")).toBe("clip.mp4");
    expect(uniqueFileName(["other.mp4"], "clip.mp4")).toBe("clip.mp4");
  });

  it("suffixes on collision, preserving the extension", () => {
    expect(uniqueFileName(["clip.mp4"], "clip.mp4")).toBe("clip (2).mp4");
    expect(uniqueFileName(["clip.mp4", "clip (2).mp4"], "clip.mp4")).toBe("clip (3).mp4");
    expect(uniqueFileName(["archive"], "archive")).toBe("archive (2)");
  });
});

describe("atomic writes (PRD §14: never a partial write)", () => {
  it("creates the file and its parent directories", async () => {
    const target = join(root, "nested", "deep", "file.txt");
    await atomicWriteFile(target, "hello");
    expect(await readFile(target, "utf8")).toBe("hello");
  });

  it("replaces existing content completely and leaves no temp files behind", async () => {
    const target = join(root, "manifest.json");
    await atomicWriteFile(target, "a".repeat(5000));
    await atomicWriteFile(target, "short");

    expect(await readFile(target, "utf8")).toBe("short");
    const leftovers = (await readdir(root)).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("writes and reads JSON round-trip", async () => {
    const target = join(root, "data.json");
    await atomicWriteJson(target, { a: 1, nested: { b: [1, 2, 3] } });
    expect(await readJsonFile(target)).toEqual({ a: 1, nested: { b: [1, 2, 3] } });
    // Trailing newline keeps the file diff-friendly in git.
    expect(await readFile(target, "utf8")).toMatch(/\n$/);
  });

  it("reports whether a path exists", async () => {
    expect(await pathExists(join(root, "nope"))).toBe(false);
    await writeFile(join(root, "yes"), "x");
    expect(await pathExists(join(root, "yes"))).toBe(true);
  });
});

describe("hashing (FR-02: duplicate detection)", () => {
  it("hashes files and bytes to the same digest", async () => {
    const target = join(root, "asset.bin");
    await writeFile(target, "content");
    expect(await hashFile(target)).toBe(hashBytes("content"));
    expect(await hashFile(target)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across repeated reads and differs for different content", async () => {
    const a = join(root, "a.bin");
    const b = join(root, "b.bin");
    await writeFile(a, "same");
    await writeFile(b, "same");
    await writeFile(join(root, "c.bin"), "different");

    expect(await hashFile(a)).toBe(await hashFile(a));
    expect(await hashFile(a)).toBe(await hashFile(b));
    expect(await hashFile(a)).not.toBe(await hashFile(join(root, "c.bin")));
  });
});

describe("workspace layout (PRD §11)", () => {
  it("creates every documented project directory", async () => {
    const workspace = await openWorkspace(join(root, "MyProject"));
    for (const directory of WORKSPACE_DIRS) {
      expect(await pathExists(safeJoin(workspace.layout.root, directory))).toBe(true);
    }
    expect(workspace.layout.manifestPath.endsWith("project.json")).toBe(true);
    expect(workspace.layout.databasePath.endsWith("project.db")).toBe(true);
  });

  it("resolves typed directories without escaping the root", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    expect(workspace.originalsDir()).toBe(join(workspace.layout.root, "assets/originals"));
    expect(workspace.generatedDir("video")).toBe(
      join(workspace.layout.root, "assets/generated/video"),
    );
    expect(workspace.cacheDir("proxies")).toBe(join(workspace.layout.root, "cache/proxies"));
    expect(workspace.exportsDir()).toBe(join(workspace.layout.root, "exports"));
    expect(() => workspace.resolve("../escape")).toThrow(UnsafePathError);
  });

  it("converts between absolute and project-relative paths", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    const inside = join(workspace.layout.root, "assets/originals/clip.mp4");
    expect(toProjectRelative(workspace.layout.root, inside)).toBe("assets/originals/clip.mp4");
    expect(fromProjectRelative(workspace.layout.root, "assets/originals/clip.mp4")).toBe(inside);

    // A path outside the workspace is the case that must be stored as a linked original.
    expect(toProjectRelative(workspace.layout.root, join(root, "elsewhere.mp4"))).toBeNull();
  });

  it("plans import destinations by origin and avoids collisions", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    const imported = planImportDestination({
      workspace,
      fileName: "My Clip.MP4",
      modality: "video",
      origin: "imported",
      existingNames: [],
    });
    expect(imported).toBe(join(workspace.layout.root, "assets/originals/My Clip.MP4"));

    const generated = planImportDestination({
      workspace,
      fileName: "shot-1.png",
      modality: "image",
      origin: "generated",
      existingNames: ["shot-1.png"],
    });
    // Collision suffixing is " (2)", " (3)", … — the first name is the un-suffixed one.
    expect(generated).toBe(join(workspace.layout.root, "assets/generated/image/shot-1 (2).png"));
  });
});

describe("storage management (PRD §14)", () => {
  it("totals directory usage recursively", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    await writeFile(join(workspace.cacheDir("thumbnails"), "a.jpg"), "12345");
    await writeFile(join(workspace.cacheDir("thumbnails"), "b.jpg"), "123");

    const usage = await directoryUsage(workspace.cacheDir("thumbnails"));
    expect(usage.files).toBe(2);
    expect(usage.bytes).toBe(8);
  });

  it("reports reclaimable cache bytes separately from assets", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    await writeFile(join(workspace.originalsDir(), "keep.mp4"), "x".repeat(100));
    await writeFile(join(workspace.cacheDir("proxies"), "derived.mp4"), "y".repeat(40));

    const usage = await workspaceUsage(workspace);
    expect(usage.cacheBytes).toBe(40);
    expect(usage.cacheReclaimableBytes).toBe(40);
    expect(usage.totalBytes).toBe(140);
  });

  it("purges only rebuildable caches and keeps assets", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    await writeFile(join(workspace.originalsDir(), "keep.mp4"), "original");
    await writeFile(join(workspace.cacheDir("proxies"), "derived.mp4"), "proxy");
    await writeFile(join(workspace.exportsDir(), "out.mp4"), "export");

    const purged = await purgeCaches(workspace);
    expect(purged).toContain("cache/proxies");
    expect(await pathExists(join(workspace.cacheDir("proxies"), "derived.mp4"))).toBe(false);
    // The cache directory is recreated so the next render can write into it.
    expect(await pathExists(workspace.cacheDir("proxies"))).toBe(true);
    expect(await pathExists(join(workspace.originalsDir(), "keep.mp4"))).toBe(true);
    expect(await pathExists(join(workspace.exportsDir(), "out.mp4"))).toBe(true);
  });

  it("never follows a symlink out of the workspace when reporting usage", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    const outside = join(root, "outside");
    await openWorkspace(outside);
    await writeFile(join(outside, "secret.mp4"), "x".repeat(999));
    await symlink(join(outside, "secret.mp4"), join(workspace.originalsDir(), "link.mp4"));

    const usage = await directoryUsage(workspace.originalsDir());
    // The symlink is not a regular file, so its target is not counted.
    expect(usage.bytes).toBe(0);
  });
});

describe("createBackup (PRD §11: backups exclude rebuildable caches)", () => {
  it("copies the project but skips caches by default", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    await writeFile(workspace.layout.manifestPath, "{}");
    await writeFile(join(workspace.originalsDir(), "clip.mp4"), "media");
    await writeFile(join(workspace.cacheDir("proxies"), "clip.mp4"), "derived");

    const result = await createBackup(workspace, {
      label: "pre-export",
      now: new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.files).toBeGreaterThanOrEqual(2);
    expect(await pathExists(join(result.destination, "project.json"))).toBe(true);
    expect(await pathExists(join(result.destination, "assets/originals/clip.mp4"))).toBe(true);
    expect(await pathExists(join(result.destination, "cache/proxies/clip.mp4"))).toBe(false);
    expect(result.skipped).toContain("cache/proxies");
  });

  it("includes caches when explicitly asked", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    await writeFile(join(workspace.cacheDir("proxies"), "clip.mp4"), "derived");
    const result = await createBackup(workspace, {
      includeCache: true,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(await pathExists(join(result.destination, "cache/proxies/clip.mp4"))).toBe(true);
    expect(result.skipped).toEqual([]);
  });

  it("never nests a backup inside another backup", async () => {
    const workspace = await openWorkspace(join(root, "P"));
    await writeFile(join(workspace.layout.root, "project.json"), "{}");
    await createBackup(workspace, { label: "one", now: new Date("2026-01-01T00:00:00Z") });
    await createBackup(workspace, { label: "two", now: new Date("2026-01-02T00:00:00Z") });

    const backups = await readdir(workspace.layout.backupsDir);
    expect(backups).toHaveLength(2);
    const nested = (await readdir(join(workspace.layout.backupsDir, backups[0]!))).filter(
      (name) => name.startsWith("two") || name.startsWith("one"),
    );
    expect(nested).toEqual([]);
  });
});

describe("makeWorkspace", () => {
  it("builds a resolver for an existing directory without creating anything", async () => {
    const missing = join(root, "does-not-exist");
    const workspace = makeWorkspace(missing);
    expect(workspace.layout.root).toBe(resolve(missing));
    expect(await pathExists(missing)).toBe(false);
  });
});
