/**
 * `@creativelab/studio` — headless project operations shared by every CLI command.
 *
 * This module is the *non-UI* consumer of the same packages the desktop app uses. That is
 * the point: if the brief → generate → timeline → export journey works here with no window,
 * no webview and no network, then the domain layer is genuinely independent of the shell.
 *
 * It deliberately exercises the paths that matter for correctness:
 *   * probing → content hashing → dedupe → atomic asset commit (FR-02)
 *   * capability validation → budget gate → provider submit → poll → provenance (FR-05…FR-10)
 *   * pure timeline edits validated against invariants (FR-03)
 *   * FFmpeg export with progress, then a probe of the produced file (FR-09)
 *   * relink verification and packaging (PRD §11)
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  AssetSchema,
  DEFAULT_BUDGET_POLICY,
  GenerationJobSchema,
  ProjectSession,
  PromptRevisionSchema,
  SqliteProjectStore,
  addMoney,
  assertTimelineInvariants,
  clipEnd,
  createEffect,
  dayKey,
  evaluateBudget,
  formatTimecode,
  hashFile,
  isoNow,
  loadMigrationsFromDisk,
  moveClip,
  newId,
  openWorkspace,
  planImportDestination,
  setClipProperties,
  splitClip,
  trimClip,
} from "@creativelab/core";

import {
  ffmpegAvailable,
  probeMedia,
  probeDurationFrames,
  renderTimeline,
} from "@creativelab/media";

import {
  MemoryCredentialVault,
  MockAdapter,
  ProviderRegistry,
  billableUnits,
  costFromPricing,
} from "@creativelab/providers";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..");
export const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "core", "migrations");

/** Modality inferred from a file extension, used for import routing and asset typing. */
const EXTENSION_MODALITY = {
  mp4: "video",
  mov: "video",
  webm: "video",
  mkv: "video",
  m4v: "video",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  wav: "audio",
  mp3: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
};

export function modalityForPath(filePath) {
  const extension = basename(filePath).toLowerCase().split(".").pop() ?? "";
  const modality = EXTENSION_MODALITY[extension];
  if (!modality) throw new Error(`Unsupported media extension ".${extension}" for ${filePath}`);
  return modality;
}

export async function loadMigrations() {
  return loadMigrationsFromDisk(MIGRATIONS_DIR);
}

// ---------------------------------------------------------------------------
// Project lifecycle
// ---------------------------------------------------------------------------

export async function initProject(options) {
  const directory = resolve(options.directory);
  const migrations = await loadMigrations();

  if (options.force === true) await resetWorkspace(directory);
  const workspace = await openWorkspace(directory);

  if (options.force !== true && (await fileExists(workspace.layout.manifestPath))) {
    throw new Error(`${workspace.layout.manifestPath} already exists; pass --force to replace it`);
  }

  const store = new SqliteProjectStore({ filename: workspace.layout.databasePath, migrations });
  const session = await ProjectSession.create(
    { workspace, store, migrations, snapshotIntervalMs: 0, autosaveDebounceMs: 0 },
    {
      title: options.title ?? basename(directory),
      fps: options.fps ?? { num: 30, den: 1 },
      width: options.width ?? 1920,
      height: options.height ?? 1080,
      colorProfile: options.colorProfile ?? "bt709",
      sampleRate: 48_000,
      channels: 2,
    },
  );
  return { session, workspace, store, migrations };
}

export async function openProject(directory) {
  const migrations = await loadMigrations();
  const workspace = await openWorkspace(resolve(directory));
  const store = new SqliteProjectStore({ filename: workspace.layout.databasePath, migrations });
  const session = await ProjectSession.open({
    workspace,
    store,
    migrations,
    snapshotIntervalMs: 0,
    autosaveDebounceMs: 0,
  });
  return { session, workspace, store, migrations };
}

/**
 * Remove an existing project so `--force` starts genuinely clean.
 *
 * Deliberately conservative: it only deletes a directory that actually looks like a
 * Creative Studio project (a manifest or database is present) and refuses obviously
 * dangerous targets. Without this, `--force` left the previous project row in place and
 * `loadDocument` happily returned the *older* project — which is how a stale run silently
 * contaminates the next one.
 */
/**
 * Pure policy check: is this path too important to ever delete?
 *
 * Extracted from `resetWorkspace` so the guard can be tested directly, without a test
 * having to risk the destructive action it is guarding.
 */
export function isProtectedResetTarget(directory) {
  const resolved = resolve(directory);
  const protectedPaths = new Set([resolve("/"), resolve(homedir()), resolve(REPO_ROOT)]);
  if (protectedPaths.has(resolved)) return true;
  // A path with fewer than two segments is a filesystem root or a top-level directory
  // (`/Users`, `C:\`); deleting one of those is never what the user meant.
  return resolved.split(/[/\\]/).filter(Boolean).length < 2;
}

export async function resetWorkspace(directory) {
  const looksLikeProject =
    (await fileExists(join(directory, "project.json"))) ||
    (await fileExists(join(directory, "project.db")));
  // Not a project: there is nothing of ours to remove, and deleting a stranger's folder
  // because the user typed `--force` would be indefensible.
  if (!looksLikeProject) return false;

  const resolved = resolve(directory);
  if (isProtectedResetTarget(resolved)) {
    throw new Error(`Refusing to remove ${resolved}: not a project directory`);
  }

  await rm(resolved, { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------------------
// Import pipeline (FR-02)
// ---------------------------------------------------------------------------

/**
 * Import a file into the project: probe, hash, dedupe, commit, and derive the background
 * derivatives (thumbnail, waveform, proxy). Mirrors the PRD §9 data flow exactly:
 * temp → verify → atomic asset commit.
 */
export async function importAsset(context, sourcePath, options = {}) {
  const { session, workspace, store } = context;
  const absoluteSource = resolve(sourcePath);
  const info = await stat(absoluteSource).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`Not a readable file: ${absoluteSource}`);

  const modality = options.modality ?? modalityForPath(absoluteSource);
  const probe = options.skipProbe ? null : await probeMedia(absoluteSource);
  const fps = session.document.project.fps;

  // Hash the *source* before copying. Content addressing is what detects a duplicate, and
  // copying first would leave an unreferenced file on disk every time a user re-imported
  // the same media (and would move gigabytes for nothing).
  const sourceHash = await hashFile(absoluteSource);
  const duplicate = await store.findAssetByHash(sourceHash);
  if (duplicate && options.allowDuplicate !== true) {
    return {
      asset: duplicate,
      duplicateOf: duplicate.id,
      warnings: ["content already imported; reusing existing asset"],
    };
  }

  const mode = options.mode ?? "copy";
  const existingNames = session.document.assets
    .map((asset) => (asset.relativePath ? basename(asset.relativePath) : null))
    .filter(Boolean);

  let targetPath = absoluteSource;
  if (mode === "copy") {
    targetPath = planImportDestination({
      workspace,
      fileName: basename(absoluteSource),
      modality,
      origin: "imported",
      existingNames,
    });
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(absoluteSource, targetPath);
  }

  const sha256 = await hashFile(targetPath);
  if (sha256 !== sourceHash) {
    throw new Error(
      `Copy verification failed for ${basename(absoluteSource)}: checksum changed during import`,
    );
  }

  const relativePath = targetPath.startsWith(workspace.layout.root)
    ? targetPath.slice(workspace.layout.root.length + 1)
    : null;
  const now = isoNow();

  const asset = AssetSchema.parse({
    id: newId("asset"),
    projectId: session.document.project.id,
    mediaType: modality,
    storageMode: mode === "copy" ? "copied" : "linked",
    uri: targetPath,
    relativePath,
    sha256,
    bytes: (await stat(targetPath)).size,
    durationFrames: probe ? probeDurationFrames(probe, fps) : null,
    width: probe?.video?.width ?? null,
    height: probe?.video?.height ?? null,
    sampleRate: probe?.audio?.sampleRate ?? null,
    channels: probe?.audio?.channels ?? null,
    fps: probe?.video?.fps ?? null,
    codec: probe?.video?.codec ?? probe?.audio?.codec ?? null,
    container: probe?.container ?? null,
    origin: "imported",
    probe: probe?.raw ?? null,
    createdAt: now,
    updatedAt: now,
  });

  await store.insertAsset(asset);
  session.applyEdit(`Import ${basename(targetPath)}`, (document) => ({
    ...document,
    assets: [...document.assets, asset],
  }));

  const warnings = [];
  const derived = await deriveMedia(context, asset).catch((error) => {
    warnings.push(`derivative generation skipped: ${error.message}`);
    return null;
  });

  return { asset, duplicateOf: null, warnings, derived, probe };
}

/** Thumbnail + waveform into the cache directory. Best-effort: cache failures are not fatal. */
export async function deriveMedia(context, asset) {
  const { workspace } = context;
  const { extractThumbnail, extractWaveformFile } = await import("@creativelab/media");
  const result = { thumbnail: null, waveform: null };

  if (asset.mediaType === "video" || asset.mediaType === "image") {
    const outPath = join(workspace.cacheDir("thumbnails"), `${asset.id}.jpg`);
    const thumbnail = await extractThumbnail(asset.uri, { outPath, timeSeconds: 0.5, width: 320 });
    result.thumbnail = thumbnail.path;
  }
  if (asset.mediaType === "video" || asset.mediaType === "audio") {
    const waveform = await extractWaveformFile(asset.uri, {
      buckets: 512,
      outPath: join(workspace.cacheDir("waveforms"), `${asset.id}.json`),
    });
    result.waveform = waveform.path;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Generation pipeline (FR-05…FR-10)
// ---------------------------------------------------------------------------

const GENERATED_EXTENSION = { image: "png", video: "mp4", audio: "wav", text: "txt" };

/**
 * Run one generation end to end and commit the result as a first-class asset.
 *
 * The ordering here is the contract from PRD §9 and §13 — capability validation, then cost
 * estimation, then the budget gate, then the durable job record, then submission:
 *
 *   Prompt → Capability validation → Cost confirmation → Local job record → Provider
 *         → Poll → Download → Verify → Atomic asset commit → (timeline insertion on user action)
 */
export async function generateAsset(context, request, options = {}) {
  const { session, workspace, store } = context;
  const now = options.now ?? (() => new Date());

  const adapter = options.adapter ?? new MockAdapter({ pollsBeforeCompletion: 2, now });
  const credentials = options.credentials ?? new MemoryCredentialVault();
  const registry = new ProviderRegistry({ adapters: [adapter] });
  const ctx = {
    credentials,
    fetch: options.fetch ?? (async () => new Response("", { status: 200 })),
    now,
  };

  // 1. Capability validation. An unsupported feature must stop here, not at the provider.
  const validation = await registry.validate(request, ctx);
  if (!validation.ok || validation.unsupported.length > 0) {
    throw new Error(
      `Request rejected for ${request.providerId}/${request.modelId}: ${[
        ...validation.errors,
        ...validation.unsupported,
      ]
        .map((issue) => `${issue.field}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  // 2. Cost estimation, then the budget gate.
  const estimate = await registry.estimateCost(request, ctx);
  const projectId = session.document.project.id;
  const today = dayKey(now());
  const ledger = await store.listSpend({ day: today });
  const spentToday = addMoney(...ledger.map((entry) => entry.amount));
  const policy = options.budget ?? DEFAULT_BUDGET_POLICY;
  const decision = evaluateBudget(policy, estimate, spentToday, today);
  if (!decision.allowed) throw new Error(`Budget refused this job: ${decision.reason}`);
  if (decision.requiresApproval && options.approve !== true) {
    throw new Error(`Budget requires approval: ${decision.reason} (pass --approve)`);
  }

  // 3. Durable job record before anything is submitted, so a crash is reconcilable.
  const createdAt = now().toISOString();
  const job = GenerationJobSchema.parse({
    id: newId("job"),
    projectId,
    providerId: request.providerId,
    modelId: request.modelId,
    mode: request.mode,
    modality: modalityForMode(request.mode),
    status: "queued",
    request: { ...request },
    costEstimate: estimate,
    createdAt,
    updatedAt: createdAt,
  });
  await store.insertJob(job);

  const transition = async (to, from, detail = null, patch = {}) => {
    Object.assign(job, patch, { status: to, updatedAt: now().toISOString() });
    await store.updateJob(job, { fromState: from, toState: to, detail });
  };

  await transition("validating", "queued");
  await transition("submitting", "validating", { estimatedCost: estimate?.amount ?? null });

  // 4. Submit, then poll to completion.
  const submission = await registry.submit(request, ctx);
  if (submission.uncertain) {
    await transition("unknown", "submitting", { reason: "provider did not confirm acceptance" });
    throw new Error(
      `Submission outcome is unknown for job ${job.id}; it must be reconciled, not retried`,
    );
  }

  Object.assign(job, {
    providerJobId: submission.providerJobId ?? null,
    submittedAt: now().toISOString(),
  });
  await transition("running", "submitting", { providerJobId: job.providerJobId });

  let status = submission.outputs
    ? { status: "completed", outputs: submission.outputs }
    : undefined;
  const maxPolls = options.maxPolls ?? 25;
  for (let attempt = 0; !status && attempt < maxPolls; attempt += 1) {
    if (!job.providerJobId) throw new Error(`Job ${job.id} has no provider job id to poll`);
    const polled = await registry.getJob(request.providerId, job.providerJobId, ctx);
    if (polled.progress !== null && polled.progress !== undefined) job.progress = polled.progress;
    if (polled.status === "failed") {
      await transition("failed", "running", { error: polled.error ?? "provider reported failure" });
      throw new Error(`Generation failed: ${polled.error ?? "provider reported failure"}`);
    }
    if (polled.status === "canceled") {
      await transition("canceled", "running");
      throw new Error("Generation was canceled");
    }
    if (polled.status === "completed") status = polled;
    else await transition("running", "running", { poll: attempt });
  }
  if (!status) throw new Error(`Job ${job.id} did not complete within ${maxPolls} polls`);

  await transition("downloading", "running");
  const outputs = await registry.fetchOutputs(request.providerId, status, ctx);
  await transition("completed", "downloading", { outputs: outputs.length });

  // 5. Verify and atomically commit each output as an asset.
  const modality = job.modality;
  const committed = [];
  for (const [index, output] of outputs.entries()) {
    const bytes = adapter.bytesFor(output);
    const directory = workspace.generatedDir(modality === "text" ? "audio" : modality);
    const extension = GENERATED_EXTENSION[output.kind] ?? GENERATED_EXTENSION[modality] ?? "bin";
    const fileName = `${request.mode.replace(/-/g, "_")}_${job.id.slice(-8)}_${index}.${extension}`;
    const target = join(directory, fileName);
    await mkdir(directory, { recursive: true });
    await writeFile(target, bytes);

    const sha256 = await hashFile(target);
    // Verify the media we just wrote: a generated asset is a first-class asset, so it
    // carries the same probed metadata an import would.
    const probe = await probeMedia(target).catch(() => null);
    const fps = session.document.project.fps;

    // Provenance: the asset points back at the job and the prompt that produced it.
    const revision = PromptRevisionSchema.parse({
      id: newId("promptRevision"),
      jobId: job.id,
      assetId: null,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt ?? null,
      references: request.references.map(
        (reference) => reference.assetId ?? reference.path ?? "inline",
      ),
      seed: request.seed ?? null,
      parameters: {
        mode: request.mode,
        aspectRatio: request.aspectRatio ?? null,
        durationSeconds: request.durationSeconds ?? null,
        voiceId: request.voiceId ?? null,
        language: request.language ?? null,
        ...(request.extra ?? {}),
      },
      createdAt: now().toISOString(),
    });
    await store.insertPromptRevision(revision);

    const asset = AssetSchema.parse({
      id: newId("asset"),
      projectId,
      mediaType: modality === "text" ? "subtitle" : modality,
      storageMode: "generated",
      uri: target,
      relativePath: target.slice(workspace.layout.root.length + 1),
      sha256,
      bytes: bytes.byteLength,
      origin: "generated",
      generationJobId: job.id,
      promptRevisionId: revision.id,
      codec: probe?.video?.codec ?? probe?.audio?.codec ?? output.mimeType,
      container: probe?.container ?? GENERATED_EXTENSION[output.kind] ?? null,
      durationFrames: probe ? probeDurationFrames(probe, fps) || null : null,
      width: probe?.video?.width ?? null,
      height: probe?.video?.height ?? null,
      sampleRate: probe?.audio?.sampleRate ?? null,
      channels: probe?.audio?.channels ?? null,
      fps: probe?.video?.fps ?? null,
      probe: probe?.raw ?? null,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    });
    await store.insertAsset(asset);
    committed.push(asset);
  }

  const outputAssetIds = committed.map((asset) => asset.id);
  Object.assign(job, {
    outputAssetIds,
    actualCost: job.costEstimate,
    completedAt: now().toISOString(),
  });
  await store.updateJob(job);

  if (estimate) {
    await store.recordSpend({
      id: newId("spend"),
      projectId,
      jobId: job.id,
      providerId: request.providerId,
      amount: estimate.amount,
      currency: estimate.currency,
      kind: "estimate",
      day: today,
      createdAt: now().toISOString(),
    });
  }

  session.applyEdit(`Generated ${modality}`, (document) => ({
    ...document,
    assets: [...document.assets, ...committed],
  }));

  return { job, assets: committed, estimate, budget: decision };
}

export function modalityForMode(mode) {
  if (mode.includes("video")) return "video";
  if (mode.includes("image")) return "image";
  if (mode === "tts" || mode === "sfx" || mode === "music") return "audio";
  if (mode === "transcription") return "subtitle";
  return "video";
}

// ---------------------------------------------------------------------------
// Timeline edits (FR-03)
// ---------------------------------------------------------------------------

export function tracksOfKind(document, kind) {
  return document.tracks
    .filter((track) => track.kind === kind)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Place an asset on a track. Insertion is an explicit user action, never automatic. */
export function placeClip(context, options) {
  const { session } = context;
  const track = options.trackId
    ? session.document.tracks.find((candidate) => candidate.id === options.trackId)
    : tracksOfKind(session.document, options.kind ?? "video")[options.trackIndex ?? 0];
  if (!track) throw new Error("No suitable track for the new clip");

  const asset = context.session.document.assets.find(
    (candidate) => candidate.id === options.assetId,
  );
  if (!asset) throw new Error(`Unknown asset ${options.assetId}`);

  const fps = session.document.project.fps;
  const fallbackFrames = Math.round((options.defaultSeconds ?? 3) * (fps.num / fps.den));
  const durationFrames =
    options.durationFrames ??
    (asset.durationFrames && asset.durationFrames > 0 ? asset.durationFrames : fallbackFrames);

  const now = isoNow();
  const clip = {
    id: newId("clip"),
    trackId: track.id,
    sequenceId: track.sequenceId,
    assetId: asset.id,
    label: options.label ?? basename(asset.relativePath ?? asset.uri),
    startFrame: options.startFrame ?? clipEndOfTrack(session.document.clips, track.id),
    sourceInFrame: options.sourceInFrame ?? 0,
    durationFrames,
    properties: {
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipX: false, flipY: false },
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
      audio: {
        gainDb: options.gainDb ?? 0,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        enabled: true,
        pan: 0,
      },
      speed: { num: 1, den: 1 },
      transitionIn: { kind: "none", durationFrames: 0 },
      transitionOut: { kind: "none", durationFrames: 0 },
      notes: "",
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  session.applyEdit(`Add ${asset.mediaType} clip`, (document) => ({
    ...document,
    clips: [...document.clips, clip],
  }));
  return clip;
}

function clipEndOfTrack(clips, trackId) {
  return clips
    .filter((clip) => clip.trackId === trackId)
    .reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
}

/** Split the clip under the playhead frame on a track. */
export function splitAt(context, trackId, frame) {
  const { session } = context;
  const target = session.document.clips.find(
    (clip) => clip.trackId === trackId && frame > clip.startFrame && frame < clipEnd(clip),
  );
  if (!target) return null;
  const result = splitClip(session.document.clips, target.id, frame);
  session.applyEdit("Split clip", (document) => ({ ...document, clips: result.clips }));
  return { leftId: result.leftId, rightId: result.rightId };
}

export function trimAt(context, clipId, edge, frame) {
  const { session } = context;
  const next = trimClip(session.document.clips, clipId, edge, frame);
  session.applyEdit("Trim clip", (document) => ({ ...document, clips: next }));
}

export function moveTo(context, clipId, toStartFrame, toTrackId) {
  const { session } = context;
  const next = moveClip(session.document.clips, session.document.tracks, {
    clipId,
    toStartFrame,
    ...(toTrackId ? { toTrackId } : {}),
  });
  session.applyEdit("Move clip", (document) => ({ ...document, clips: next }));
}

export function setOpacity(context, clipId, opacity) {
  const { session } = context;
  const next = setClipProperties(session.document.clips, clipId, { transform: { opacity } });
  session.applyEdit("Set opacity", (document) => ({ ...document, clips: next }));
}

export function addBrightness(context, clipId, amount) {
  const { session } = context;
  session.applyEdit("Add effect", (document) => ({
    ...document,
    // Clip effects are additive; nothing about the source file changes (PRD §4).
    effects: [...document.effects, createEffect(clipId, "brightness", { amount })],
  }));
}

// ---------------------------------------------------------------------------
// Export (FR-09)
// ---------------------------------------------------------------------------

/** Resolve every asset a clip references into the shape the filter-graph builder needs. */
export function assetResolver(context) {
  const { session, workspace } = context;
  const resolver = new Map();
  for (const asset of session.document.assets) {
    const absolute = asset.relativePath
      ? join(workspace.layout.root, asset.relativePath)
      : asset.uri;
    resolver.set(asset.id, {
      path: absolute,
      durationFrames: asset.durationFrames ?? undefined,
      hasAudio:
        asset.mediaType === "audio" || (asset.mediaType === "video" && asset.channels !== null),
      width: asset.width ?? undefined,
      height: asset.height ?? undefined,
      fps: asset.fps ?? undefined,
    });
  }
  return resolver;
}

export async function exportTimeline(context, options = {}) {
  const { session, workspace } = context;
  assertTimelineInvariants(session.document);
  await session.flushAutosave();

  const preset = options.preset;
  const outputDir = options.outputDir ?? workspace.exportsDir();
  await mkdir(outputDir, { recursive: true });

  const progressEvents = [];
  const result = await renderTimeline(session.document, {
    outputDir,
    preset,
    assets: assetResolver(context),
    ...(options.outputName ? { outputName: options.outputName } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    onProgress: (progress) => {
      progressEvents.push(progress);
      options.onProgress?.(progress);
    },
  });

  return { ...result, progressEvents };
}

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

/** Generate a real, playable test clip with FFmpeg's lavfi sources. */
export async function makeFixtureVideo(path, options = {}) {
  const seconds = options.seconds ?? 3;
  const size = options.size ?? "640x360";
  const rate = options.rate ?? 30;
  const source = options.source ?? "testsrc2";
  await runFfmpegQuiet([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `${source}=size=${size}:rate=${rate}:duration=${seconds}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${options.frequency ?? 440}:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    path,
  ]);
  return path;
}

export async function makeFixtureAudio(path, options = {}) {
  const seconds = options.seconds ?? 5;
  await runFfmpegQuiet([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${options.frequency ?? 220}:duration=${seconds}`,
    // Real PCM: an `.wav` container holding AAC is not a WAV, and ffprobe would
    // legitimately reject it.
    "-c:a",
    "pcm_s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    path,
  ]);
  return path;
}

function runFfmpegQuiet(args) {
  return new Promise((resolvePromise, reject) => {
    // Argument array, never a shell string (PRD §13).
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(undefined)
        : reject(new Error(`ffmpeg exited ${code}: ${stderr.split("\n").slice(-6).join("\n")}`)),
    );
  });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function describeDocument(document) {
  const frameRate = document.project.fps;
  return {
    title: document.project.title,
    resolution: `${document.project.width}x${document.project.height}`,
    fps: `${frameRate.num}/${frameRate.den}`,
    durationFrames: document.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0),
    durationTimecode: formatTimecode(
      document.clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0),
      frameRate,
    ),
    tracks: document.tracks.length,
    clips: document.clips.length,
    effects: document.effects.length,
    assets: document.assets.length,
    generatedAssets: document.assets.filter((asset) => asset.origin === "generated").length,
  };
}

export { billableUnits, costFromPricing, probeDurationFrames, probeMedia, ffmpegAvailable };

export async function fileExists(path) {
  return Boolean(await stat(path).catch(() => undefined));
}
