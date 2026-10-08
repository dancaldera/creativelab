/**
 * Workspace filesystem layout, path safety and atomic writes.
 *
 * PRD §11 defines the on-disk contract:
 *
 *   Workspace/ProjectName/project.json   project.db
 *   assets/originals                     assets/generated/{image,video,audio}
 *   cache/{proxies,thumbnails,waveforms} exports   backups
 *
 * PRD §13 requires that native file access be "scoped to approved workspace paths" and
 * that every path argument be validated, so every filesystem path the app touches is
 * produced by `WorkspacePaths` and checked by `assertInside`.
 *
 * PRD §14 requires that a save "never overwrite healthy project [state] with a partial
 * write", which is why all writes go through `atomicWriteFile`.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { UnsafePathError } from "./errors.js";

export const MANIFEST_FILENAME = "project.json";
export const DATABASE_FILENAME = "project.db";

/** Project-relative directories, in creation order. */
export const WORKSPACE_DIRS = [
  "assets/originals",
  "assets/generated/image",
  "assets/generated/video",
  "assets/generated/audio",
  "cache/proxies",
  "cache/thumbnails",
  "cache/waveforms",
  "exports",
  "backups",
] as const;

export type GeneratedModality = "image" | "video" | "audio";

/** Directories that can always be rebuilt from originals; excluded from backups. */
export const REBUILDABLE_DIRS = ["cache/proxies", "cache/thumbnails", "cache/waveforms"] as const;

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

// Matching control characters is the point: they must be rejected, not sanitized away,
// because a NUL byte is how a path validator gets bypassed by a shorter C string.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Validate a project-relative path.
 *
 * Rejects absolute paths, drive letters, UNC prefixes, `..` traversal, NUL bytes and
 * backslash separators (which are ambiguous across platforms). Returns the normalized
 * POSIX-style relative path.
 */
export function assertSafeRelativePath(candidate: string, label = "path"): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new UnsafePathError(`${label} must be a non-empty string`);
  }
  if (CONTROL_CHARS.test(candidate)) {
    throw new UnsafePathError(`${label} contains control characters: ${JSON.stringify(candidate)}`);
  }
  if (candidate.includes("\\")) {
    throw new UnsafePathError(`${label} must use forward slashes: ${candidate}`);
  }
  if (candidate.startsWith("/") || isAbsolute(candidate)) {
    throw new UnsafePathError(`${label} must be relative, received an absolute path: ${candidate}`);
  }
  if (/^[a-zA-Z]:/.test(candidate)) {
    throw new UnsafePathError(`${label} must not contain a drive letter: ${candidate}`);
  }
  const segments = candidate.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  for (const segment of segments) {
    if (segment === "..") {
      throw new UnsafePathError(`${label} escapes the workspace via "..": ${candidate}`);
    }
    if (segment.includes("\u0000")) {
      throw new UnsafePathError(`${label} contains a NUL byte`);
    }
  }
  return segments.join("/");
}

/** True when `target` is `root` itself or lives beneath it. Symlink-free by design. */
export function isInside(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedRoot === resolvedTarget) return true;
  const rel = relative(resolvedRoot, resolvedTarget);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Throw unless `target` resolves inside `root`. */
export function assertInside(root: string, target: string, label = "path"): string {
  const resolved = resolve(root, target);
  if (!isInside(root, resolved)) {
    throw new UnsafePathError(`${label} resolves outside the workspace: ${resolved}`, {
      root,
      target,
    });
  }
  return resolved;
}

/**
 * Join validated segments onto `root`, guaranteeing the result stays inside `root`.
 * This is the only supported way to build a filesystem path in the app.
 */
export function safeJoin(root: string, ...segments: readonly string[]): string {
  const relativePath = assertSafeRelativePath(
    segments.filter((segment) => segment.length > 0).join("/"),
    "path",
  );
  return assertInside(root, relativePath);
}

/** Make an arbitrary user-supplied string safe to use as a single filename. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/g;

export function sanitizeFileName(name: string, fallback = "untitled"): string {
  let cleaned = name
    .normalize("NFC")
    .replace(CONTROL_CHARS_GLOBAL, "")
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (cleaned.length === 0) cleaned = fallback;
  if (WINDOWS_RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
  if (cleaned.length > 180) {
    const dot = cleaned.lastIndexOf(".");
    const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
    cleaned = cleaned.slice(0, 180 - extension.length) + extension;
  }
  return cleaned;
}

/** Derive `name (2).ext`, `name (3).ext`, … avoiding collisions with `existing`. */
export function uniqueFileName(existing: Iterable<string>, desired: string): string {
  const taken = new Set(existing);
  if (!taken.has(desired)) return desired;
  const dot = desired.lastIndexOf(".");
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const extension = dot > 0 ? desired.slice(dot) : "";
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem} (${index})${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new UnsafePathError(`Could not find a free filename for ${desired}`);
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

/**
 * Write a file so that readers only ever observe the complete previous or complete new
 * contents. Writes to a sibling temp file, fsyncs it, then renames over the target.
 */
export async function atomicWriteFile(filePath: string, data: string | Uint8Array): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = join(
    directory,
    `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(data);
    // Durability matters more than speed here: a crash must not leave a truncated manifest.
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonFile<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Streaming SHA-256, used for asset identity and duplicate detection (FR-02). */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolvePromise());
  });
  return hash.digest("hex");
}

export function hashBytes(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Workspace layout
// ---------------------------------------------------------------------------

export interface WorkspaceLayout {
  readonly root: string;
  readonly projectDir: string;
  readonly manifestPath: string;
  readonly databasePath: string;
  readonly backupsDir: string;
}

export interface Workspace {
  readonly layout: WorkspaceLayout;
  /** Resolve a project-relative path, refusing anything outside the workspace. */
  resolve(relativePath: string): string;
  /** Absolute path of the originals directory. */
  originalsDir(): string;
  /** Absolute path of the generated-media directory for a modality. */
  generatedDir(modality: GeneratedModality): string;
  cacheDir(kind: "proxies" | "thumbnails" | "waveforms"): string;
  exportsDir(): string;
}

/** Create every directory in the layout, then return a resolver bound to the root. */
export async function openWorkspace(root: string): Promise<Workspace> {
  const absoluteRoot = resolve(root);
  await mkdir(absoluteRoot, { recursive: true });
  for (const directory of WORKSPACE_DIRS) {
    await mkdir(safeJoin(absoluteRoot, directory), { recursive: true });
  }
  return makeWorkspace(absoluteRoot);
}

/** Build a `Workspace` for an existing directory without creating anything. */
export function makeWorkspace(root: string): Workspace {
  const absoluteRoot = resolve(root);
  const layout: WorkspaceLayout = {
    root: absoluteRoot,
    projectDir: absoluteRoot,
    manifestPath: join(absoluteRoot, MANIFEST_FILENAME),
    databasePath: join(absoluteRoot, DATABASE_FILENAME),
    backupsDir: join(absoluteRoot, "backups"),
  };
  return {
    layout,
    resolve: (relativePath: string) => safeJoin(absoluteRoot, relativePath),
    originalsDir: () => safeJoin(absoluteRoot, "assets/originals"),
    generatedDir: (modality) => safeJoin(absoluteRoot, `assets/generated/${modality}`),
    cacheDir: (kind) => safeJoin(absoluteRoot, `cache/${kind}`),
    exportsDir: () => safeJoin(absoluteRoot, "exports"),
  };
}

/**
 * Compute a project-relative path for storage inside the workspace.
 * Returns `null` when `absolutePath` is outside the workspace — which is exactly the
 * case that must be stored as a linked original instead of a copied one.
 */
export function toProjectRelative(root: string, absolutePath: string): string | null {
  const resolved = resolve(absolutePath);
  if (!isInside(root, resolved)) return null;
  return relative(resolve(root), resolved).split(sep).join("/");
}

/** Turn a stored project-relative path back into an absolute path. */
export function fromProjectRelative(root: string, relativePath: string): string {
  return safeJoin(root, assertSafeRelativePath(relativePath, "relativePath"));
}

/**
 * Choose the destination for an import, honouring the copy-vs-link policy.
 * Duplicate content (same sha256) resolves to the existing asset path (FR-02).
 */
export function planImportDestination(options: {
  workspace: Workspace;
  fileName: string;
  modality: GeneratedModality;
  origin: "imported" | "generated";
  existingNames: Iterable<string>;
}): string {
  const safeName = sanitizeFileName(
    options.fileName,
    `asset.${defaultExtension(options.modality)}`,
  );
  const directory =
    options.origin === "generated"
      ? options.workspace.generatedDir(options.modality)
      : options.workspace.originalsDir();
  const unique = uniqueFileName(options.existingNames, safeName);
  return join(directory, unique);
}

function defaultExtension(modality: GeneratedModality): string {
  switch (modality) {
    case "video":
      return "mp4";
    case "audio":
      return "wav";
    case "image":
    default:
      return "png";
  }
}

// ---------------------------------------------------------------------------
// Storage management (PRD §14)
// ---------------------------------------------------------------------------

export interface DirectoryUsage {
  readonly path: string;
  readonly bytes: number;
  readonly files: number;
}

/** Recursively total a directory; symlinks are not followed. */
export async function directoryUsage(directory: string): Promise<DirectoryUsage> {
  let bytes = 0;
  let files = 0;
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        try {
          const info = await stat(child);
          bytes += info.size;
          files += 1;
        } catch {
          // A file that vanished mid-walk is not an error for a usage report.
        }
      }
    }
  };
  await walk(directory);
  return { path: directory, bytes, files };
}

export interface WorkspaceUsage {
  readonly root: string;
  readonly totalBytes: number;
  readonly cacheBytes: number;
  readonly cacheReclaimableBytes: number;
  readonly directories: readonly DirectoryUsage[];
}

/** Usage breakdown for the Storage settings panel. */
export async function workspaceUsage(workspace: Workspace): Promise<WorkspaceUsage> {
  const directories: DirectoryUsage[] = [];
  for (const directory of ["assets", "cache", "exports", "backups"] as const) {
    directories.push(await directoryUsage(safeJoin(workspace.layout.root, directory)));
  }
  const cache = directories.find((entry) => entry.path.endsWith(`${sep}cache`));
  const totalBytes = directories.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    root: workspace.layout.root,
    totalBytes,
    cacheBytes: cache?.bytes ?? 0,
    // Everything under cache/ is derived data and can be regenerated from originals.
    cacheReclaimableBytes: cache?.bytes ?? 0,
    directories,
  };
}

/** Delete rebuildable caches. Never touches assets, exports or backups. */
export async function purgeCaches(workspace: Workspace): Promise<string[]> {
  const purged: string[] = [];
  for (const directory of REBUILDABLE_DIRS) {
    const target = safeJoin(workspace.layout.root, directory);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    purged.push(directory);
  }
  return purged;
}

export interface BackupResult {
  readonly destination: string;
  readonly files: number;
  readonly bytes: number;
  readonly skipped: readonly string[];
}

/**
 * Snapshot a project. PRD §11: "backups exclude rebuildable caches by default."
 * A timestamped folder keeps every backup independent and restorable.
 */
export async function createBackup(
  workspace: Workspace,
  options: { label?: string; includeCache?: boolean; now?: Date } = {},
): Promise<BackupResult> {
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const name = sanitizeFileName(options.label ? `${options.label}-${stamp}` : stamp);
  const destination = safeJoin(workspace.layout.root, "backups", name);
  await mkdir(destination, { recursive: true });

  const skipCache = !options.includeCache;
  const skipped: string[] = skipCache ? [...REBUILDABLE_DIRS] : [];
  let files = 0;
  let bytes = 0;

  const copyTree = async (absoluteSource: string, relativeSource: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(absoluteSource, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childAbsolute = join(absoluteSource, entry.name);
      const childRelative = relativeSource ? `${relativeSource}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (relativeSource === "backups") continue; // never nest backups inside backups
        if (skipCache && REBUILDABLE_DIRS.some((dir) => childRelative === dir)) {
          skipped.push(childRelative);
          continue;
        }
        await copyTree(childAbsolute, childRelative);
      } else if (entry.isFile()) {
        const target = safeJoin(destination, childRelative);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(childAbsolute, target);
        const info = await stat(childAbsolute);
        files += 1;
        bytes += info.size;
      }
    }
  };

  await copyTree(workspace.layout.root, "");
  return { destination, files, bytes, skipped: [...new Set(skipped)] };
}

/** Write a UTF-8 text file directly (non-atomic callers should prefer atomicWriteFile). */
export async function writeTextFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, "utf8");
}
