/**
 * `project.json` — the portable, human-readable manifest (PRD §11).
 *
 * The SQLite database is the working store; the manifest is what makes a project
 * *ownable*. It contains project settings and the full timeline with **project-relative**
 * media references, so a packaged project reopens on another machine without relinking.
 */
import { readFile } from "node:fs/promises";
import type { Asset, EditorDocument } from "./schema.js";
import { MANIFEST_VERSION, ProjectManifestSchema, type ProjectManifest } from "./schema.js";
import { atomicWriteJson, fromProjectRelative, pathExists } from "./workspace.js";
import { z } from "zod";

export const GENERATOR_ID = "creativelab/0.1.0";

export function buildManifest(document: EditorDocument, now = new Date()): ProjectManifest {
  return ProjectManifestSchema.parse({
    manifestVersion: MANIFEST_VERSION,
    schemaVersion: document.project.schemaVersion,
    generator: GENERATOR_ID,
    project: document.project,
    sequences: document.sequences,
    tracks: document.tracks,
    clips: document.clips,
    effects: document.effects,
    keyframes: document.keyframes,
    assets: document.assets,
    exportedAt: now.toISOString(),
  });
}

/** Convert a manifest back into the in-memory document shape. */
export function manifestToDocument(manifest: ProjectManifest): EditorDocument {
  return {
    project: manifest.project,
    sequences: manifest.sequences,
    tracks: manifest.tracks,
    clips: manifest.clips,
    effects: manifest.effects,
    keyframes: manifest.keyframes,
    assets: manifest.assets,
  };
}

export function serializeManifest(manifest: ProjectManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Parse with a helpful error that names the offending field path. */
export function parseManifest(text: string): ProjectManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(`project.json is not valid JSON: ${(error as Error).message}`);
  }
  const result = ProjectManifestSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ManifestError(
      `project.json failed validation at ${issue?.path.join(".") || "<root>"}: ${issue?.message}`,
      result.error.issues.map((item) => ({ path: item.path.join("."), message: item.message })),
    );
  }
  return result.data;
}

export async function readManifest(path: string): Promise<ProjectManifest> {
  return parseManifest(await readFile(path, "utf8"));
}

export async function writeManifest(path: string, manifest: ProjectManifest): Promise<void> {
  // Atomic: a crash mid-write must never leave a half-written manifest (PRD §14).
  await atomicWriteJson(path, manifest);
}

export class ManifestError extends Error {
  readonly issues: readonly { path: string; message: string }[];
  constructor(message: string, issues: readonly { path: string; message: string }[] = []) {
    super(message);
    this.name = "ManifestError";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Relink validation (FR-02, PRD §11)
// ---------------------------------------------------------------------------

export type AssetIssueKind = "missing" | "not-packaged" | "checksum-mismatch" | "no-reference";

export interface AssetIssue {
  readonly assetId: string;
  readonly kind: AssetIssueKind;
  readonly uri: string;
  readonly relativePath: string | null;
  readonly message: string;
}

export interface RelinkReport {
  readonly checked: number;
  readonly ok: number;
  readonly issues: readonly AssetIssue[];
  /** True when every asset resolves, i.e. the project is fully portable. */
  readonly portable: boolean;
}

/**
 * Check every asset against the workspace on disk.
 *
 * Three outcomes are distinguished, and the distinction matters for packaging:
 *   * `ok`           — resolvable through a project-relative path, so the project is
 *                      self-contained and will relink anywhere.
 *   * `missing`      — the media is not where the project says it is; the user must relink.
 *   * `not-packaged` — the media exists but lives *outside* the project (a linked original
 *                      or a remote URL). The project still opens here, but copying it to
 *                      another machine would break, so `Package Project` must warn.
 *
 * A linked original is reported as `not-packaged` even when its absolute path currently
 * resolves — portability is about the reference stored in the manifest, not about whether
 * this particular machine happens to have the file.
 */
export async function verifyAssets(root: string, assets: readonly Asset[]): Promise<RelinkReport> {
  const issues: AssetIssue[] = [];
  let ok = 0;

  for (const asset of assets) {
    if (asset.relativePath) {
      const absolute = fromProjectRelative(root, asset.relativePath);
      if (await pathExists(absolute)) {
        ok += 1;
      } else {
        issues.push({
          assetId: asset.id,
          kind: "missing",
          uri: asset.uri,
          relativePath: asset.relativePath,
          message: `Expected media at ${asset.relativePath} but the file is not there.`,
        });
      }
      continue;
    }

    if (asset.uri.startsWith("http://") || asset.uri.startsWith("https://")) {
      issues.push({
        assetId: asset.id,
        kind: "not-packaged",
        uri: asset.uri,
        relativePath: null,
        message: "Remote original: package the project to pull this media local.",
      });
      continue;
    }

    const exists = await pathExists(asset.uri);
    if (!exists) {
      issues.push({
        assetId: asset.id,
        kind: "missing",
        uri: asset.uri,
        relativePath: null,
        message: "Linked original is no longer at its recorded path; relink it to continue.",
      });
      continue;
    }

    issues.push({
      assetId: asset.id,
      kind: "not-packaged",
      uri: asset.uri,
      relativePath: null,
      message:
        "This media is linked from outside the project folder, so the project is not self-contained.",
    });
  }

  return { checked: assets.length, ok, issues, portable: issues.length === 0 };
}

/** Two manifests describe the same project and timeline (ignoring timestamps). */
export function manifestsEquivalent(a: ProjectManifest, b: ProjectManifest): boolean {
  const strip = (manifest: ProjectManifest): string =>
    JSON.stringify({
      project: { ...manifest.project, updatedAt: "" },
      sequences: manifest.sequences,
      tracks: manifest.tracks,
      clips: manifest.clips,
      effects: manifest.effects,
      keyframes: manifest.keyframes,
      assets: manifest.assets.map((asset) => ({ ...asset, updatedAt: "", missingAt: null })),
    });
  return strip(a) === strip(b);
}

export const ManifestVersionSchema = z.number().int().min(1);
