/**
 * `MockStudioBridge` — a complete, in-memory `StudioBridge`.
 *
 * This is what makes the renderer runnable in a plain browser (`pnpm dev`) and testable
 * without a native build: it implements every allowlisted command against
 * `@creativelab/core` types and pure operations only. No network, no filesystem, no Tauri.
 *
 * Deliberate properties:
 *   * **Singleton state.** A module-level `mockState` object survives React re-renders and
 *     hot reloads, so switching panels does not silently create a new project.
 *   * **Real documents.** `project_create` returns an FR-03 starter document with 3 video,
 *     4 audio and 1 caption track.
 *   * **Secret hygiene.** `credential_set` stores the raw secret in a closure-private map
 *     that is never returned, stringified or embedded in any DTO. Only `credentialRef`
 *     and `hasSecret` cross the boundary — the same rule the Rust side enforces.
 *   * **Deterministic-ish media.** Thumbnails are small PNG data URIs derived from the
 *     asset id, waveforms are a stable pseudo-random peak series, and render progress is
 *     a function of elapsed wall-clock time rather than a `setInterval`.
 */
import type { Asset, EditorDocument } from "@creativelab/core";
import type {
  AssetDto,
  AssetImportRequest,
  AssetImportResponse,
  CredentialRefDto,
  CredentialSetRequest,
  CredentialTestRequest,
  CredentialTestResponse,
  DialogResultDto,
  DocumentDto,
  FileFilter,
  ImportedAssetDto,
  JobDto,
  JobListRequest,
  JobListResponse,
  JobReconcileResponse,
  MediaProxyRequest,
  MediaProxyResponse,
  MediaThumbnailRequest,
  MediaThumbnailResponse,
  MediaWaveformRequest,
  MediaWaveformResponse,
  ProjectCreateRequest,
  ProjectPackageRequest,
  ProjectPackageResponse,
  ProjectSaveRequest,
  ProjectSaveResponse,
  ProjectSessionDto,
  ProjectSummaryDto,
  ProviderListModelsRequest,
  ProviderListModelsResponse,
  ProviderModelDto,
  RecoveryOfferDto,
  RenderCancelRequest,
  RenderStartRequest,
  RenderStartResponse,
  RenderStatusRequest,
  RenderStatusResponse,
  SettingsGetRequest,
  SettingsGetResponse,
  SettingsSetRequest,
  StudioBridge,
  WorkspaceUsageRequest,
  WorkspaceUsageResponse,
} from "./protocol";
import { createInitialDocument, frameRateAsNumber, isoNow, newId, sequenceDurationFrames } from "../state/coreOps";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function hashString(input: string): string {
  // FNV-1a rendered as 64 hex chars so it *looks* like a sha256 for dedupe demos.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  const chunk = hash.toString(16).padStart(16, "0");
  return chunk.repeat(4);
}

function pseudoRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? path;
}

function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

const VIDEO_EXT = new Set(["mp4", "mov", "webm", "mkv", "m4v"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);
const AUDIO_EXT = new Set(["wav", "mp3", "m4a", "aac", "flac", "ogg"]);
const SUBTITLE_EXT = new Set(["srt", "vtt"]);

function mediaTypeOf(path: string): Asset["mediaType"] {
  const ext = extensionOf(path);
  if (VIDEO_EXT.has(ext)) return "video";
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (SUBTITLE_EXT.has(ext)) return "subtitle";
  return "video";
}

// ---------------------------------------------------------------------------
// Built-in model catalog
// ---------------------------------------------------------------------------

interface MockModelSeed {
  providerId: string;
  modelId: string;
  displayName: string;
  modality: string;
  unitPrice: number | null;
  capabilities: Record<string, unknown>;
}

const MODEL_SEEDS: readonly MockModelSeed[] = [
  {
    providerId: "vercel-gateway",
    modelId: "openai/gpt-image-1",
    displayName: "GPT Image 1",
    modality: "image",
    unitPrice: 0.04,
    capabilities: {
      modes: ["text-to-image", "image-to-image"],
      inputMimeTypes: ["image/png", "image/jpeg", "image/webp"],
      aspectRatios: ["16:9", "9:16", "1:1", "4:3"],
      resolutions: ["1024x1024", "1536x1024", "1024x1536"],
      durationMinSeconds: null,
      durationMaxSeconds: null,
      supportsSeed: false,
      supportsNegativePrompt: false,
      referenceFrame: "optional",
      supportsAudio: false,
      voices: [],
      languages: [],
      maxConcurrency: 4,
      pricing: { unit: "image", amount: 0.04, currency: "USD" },
      quota: null,
      safety: { moderation: "provider" },
    },
  },
  {
    providerId: "vercel-gateway",
    modelId: "google/veo-3",
    displayName: "Veo 3 (video)",
    modality: "video",
    unitPrice: 0.75,
    capabilities: {
      modes: ["text-to-video", "image-to-video"],
      inputMimeTypes: ["image/png", "image/jpeg"],
      aspectRatios: ["16:9", "9:16"],
      resolutions: ["1280x720", "1920x1080"],
      durationMinSeconds: 4,
      durationMaxSeconds: 8,
      supportsSeed: true,
      supportsNegativePrompt: true,
      referenceFrame: "optional",
      supportsAudio: true,
      voices: [],
      languages: [],
      maxConcurrency: 2,
      pricing: { unit: "second", amount: 0.75, currency: "USD" },
      quota: null,
      safety: { moderation: "provider" },
    },
  },
  {
    providerId: "vercel-gateway",
    modelId: "minimax/hailuo-02",
    displayName: "Hailuo 02",
    modality: "video",
    unitPrice: 0.28,
    capabilities: {
      modes: ["text-to-video", "image-to-video"],
      inputMimeTypes: ["image/png", "image/jpeg"],
      aspectRatios: ["16:9", "9:16", "1:1"],
      resolutions: ["1280x720"],
      durationMinSeconds: 6,
      durationMaxSeconds: 6,
      supportsSeed: true,
      supportsNegativePrompt: false,
      referenceFrame: "optional",
      supportsAudio: false,
      voices: [],
      languages: [],
      maxConcurrency: 2,
      pricing: { unit: "video", amount: 0.28, currency: "USD" },
      quota: null,
      safety: { moderation: "provider" },
    },
  },
  {
    providerId: "elevenlabs",
    modelId: "eleven_multilingual_v2",
    displayName: "Eleven Multilingual v2",
    modality: "audio",
    unitPrice: 0.00018,
    capabilities: {
      modes: ["tts"],
      inputMimeTypes: ["text/plain"],
      aspectRatios: [],
      resolutions: [],
      durationMinSeconds: null,
      durationMaxSeconds: null,
      supportsSeed: true,
      supportsNegativePrompt: false,
      referenceFrame: "none",
      supportsAudio: true,
      voices: ["Rachel", "Adam", "Bella", "Antoni", "Domi"],
      languages: ["en", "es", "fr", "de", "pt", "it"],
      maxConcurrency: 4,
      pricing: { unit: "character", amount: 0.00018, currency: "USD" },
      quota: null,
      safety: { cloning: "consent-required" },
    },
  },
  {
    providerId: "elevenlabs",
    modelId: "eleven_sound_effects_v1",
    displayName: "Sound Effects v1",
    modality: "audio",
    unitPrice: 0.02,
    capabilities: {
      modes: ["sfx"],
      inputMimeTypes: ["text/plain"],
      aspectRatios: [],
      resolutions: [],
      durationMinSeconds: 0.5,
      durationMaxSeconds: 22,
      supportsSeed: true,
      supportsNegativePrompt: false,
      referenceFrame: "none",
      supportsAudio: true,
      voices: [],
      languages: [],
      maxConcurrency: 4,
      pricing: { unit: "second", amount: 0.02, currency: "USD" },
      quota: null,
      safety: {},
    },
  },
  {
    providerId: "elevenlabs",
    modelId: "scribe_v1",
    displayName: "Scribe v1 (transcription)",
    modality: "subtitle",
    unitPrice: null,
    capabilities: {
      modes: ["transcription"],
      inputMimeTypes: ["audio/wav", "audio/mpeg", "video/mp4"],
      aspectRatios: [],
      resolutions: [],
      durationMinSeconds: null,
      durationMaxSeconds: null,
      supportsSeed: false,
      supportsNegativePrompt: false,
      referenceFrame: "none",
      supportsAudio: true,
      voices: [],
      languages: ["en", "es", "fr"],
      maxConcurrency: 2,
      pricing: null,
      quota: null,
      safety: {},
    },
  },
  {
    providerId: "cloudflare-ai",
    modelId: "@cf/black-forest-labs/flux-1-schnell",
    displayName: "FLUX.1 schnell (Workers AI)",
    modality: "image",
    unitPrice: 0.0001,
    capabilities: {
      modes: ["text-to-image"],
      inputMimeTypes: ["text/plain"],
      aspectRatios: ["1:1", "16:9", "9:16"],
      resolutions: ["1024x1024"],
      durationMinSeconds: null,
      durationMaxSeconds: null,
      supportsSeed: true,
      supportsNegativePrompt: true,
      referenceFrame: "none",
      supportsAudio: false,
      voices: [],
      languages: [],
      maxConcurrency: 8,
      pricing: { unit: "image", amount: 0.0001, currency: "USD" },
      quota: null,
      safety: {},
    },
  },
];

function modelDto(seed: MockModelSeed, fetchedAt: string): ProviderModelDto {
  return {
    providerId: seed.providerId,
    modelId: seed.modelId,
    displayName: seed.displayName,
    modality: seed.modality,
    capabilities: { ...seed.capabilities, unitPrice: seed.unitPrice },
    pricing: (seed.capabilities["pricing"] as Record<string, unknown> | null) ?? null,
    fetchedAt,
    isStale: false,
  };
}

// ---------------------------------------------------------------------------
// Mock state (module-level singleton)
// ---------------------------------------------------------------------------

interface MockRender {
  exportJobId: string;
  sequenceId: string;
  presetId: string;
  outputPath: string;
  burnInCaptions: boolean;
  startedAt: number;
  totalFrames: number;
  canceled: boolean;
  failed: boolean;
}

interface MockState {
  /** Injectable clock so render-progress tests are deterministic (no sleeping). */
  now: () => number;
  document: EditorDocument | null;
  workspacePath: string | null;
  recovery: RecoveryOfferDto | null;
  dirty: boolean;
  /** Provider secrets. Closure-private by convention: never returned by any method. */
  secrets: Map<string, string>;
  settings: Map<string, unknown>;
  jobs: Map<string, JobDto>;
  renders: Map<string, MockRender>;
  recents: ProjectSummaryDto[];
  catalogFetchedAt: string;
  proxyCount: number;
}

function createState(): MockState {
  return {
    now: () => Date.now(),
    document: null,
    workspacePath: null,
    recovery: null,
    dirty: false,
    secrets: new Map<string, string>(),
    settings: new Map<string, unknown>(),
    jobs: new Map<string, JobDto>(),
    renders: new Map<string, MockRender>(),
    recents: [],
    catalogFetchedAt: isoNow(),
    proxyCount: 0,
  };
}

let mockState: MockState = createState();

/** Test hook: drop every scrap of mock state. */
export function resetMockState(): void {
  mockState = createState();
}

/** Test hook: inspect the workspace the mock currently believes is open. */
export function mockWorkspacePath(): string | null {
  return mockState.workspacePath;
}

/**
 * Test hook: move a render's recorded start time into the past.
 *
 * Render progress is a function of elapsed wall-clock time rather than an interval, so this
 * is how a test proves progress actually advances without sleeping.
 */
export function advanceMockRenderClock(exportJobId: string, milliseconds: number): void {
  const render = mockState.renders.get(exportJobId);
  if (!render) throw new Error(`Mock bridge: unknown export job ${exportJobId}`);
  render.startedAt -= milliseconds;
}

// ---------------------------------------------------------------------------
// Document <-> DTO projection
// ---------------------------------------------------------------------------

function toAssetDto(asset: Asset): AssetDto {
  return {
    id: asset.id,
    projectId: asset.projectId,
    mediaType: asset.mediaType,
    storageMode: asset.storageMode,
    uri: asset.uri,
    relativePath: asset.relativePath,
    sha256: asset.sha256,
    bytes: asset.bytes,
    durationFrames: asset.durationFrames,
    width: asset.width,
    height: asset.height,
    sampleRate: asset.sampleRate,
    channels: asset.channels,
    fps: asset.fps,
    codec: asset.codec,
    container: asset.container,
    origin: asset.origin,
    parentAssetId: asset.parentAssetId,
    generationJobId: asset.generationJobId,
    promptRevisionId: asset.promptRevisionId,
    probe: asset.probe,
    missingAt: asset.missingAt,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

/**
 * Project the in-memory document onto the frozen `DocumentDto` shape.
 *
 * `DocumentDto` is structurally `EditorDocument` with `Record<string, unknown>` bags for
 * `properties`/`probe`; the mapping is explicit so a schema change cannot silently leak.
 */
function toDocumentDto(document: EditorDocument): DocumentDto {
  return {
    project: { ...document.project },
    sequences: document.sequences.map((sequence) => ({ ...sequence })),
    tracks: document.tracks.map((track) => ({ ...track })),
    clips: document.clips.map((clip) => ({ ...clip, properties: { ...clip.properties } })),
    effects: document.effects.map((effect) => ({ ...effect })),
    keyframes: document.keyframes.map((keyframe) => ({ ...keyframe })),
    assets: document.assets.map(toAssetDto),
  };
}

/**
 * The reverse projection used by `project_save`.
 *
 * The cast is the boundary: `DocumentDto` is deliberately looser than `EditorDocument`
 * (`properties` is a `Record<string, unknown>` bag and `colorProfile` is a bare string) so
 * the protocol stays decoupled from the zod-validated core schema. Rust performs the real
 * validation on save, and the renderer only round-trips documents it received from the
 * bridge, so no unvalidated shape is introduced here.
 */
export function documentFromDto(dto: DocumentDto): EditorDocument {
  return dto as unknown as EditorDocument;
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

const THUMBNAIL_WIDTH = 160;
const THUMBNAIL_HEIGHT = 90;

export class MockStudioBridge implements StudioBridge {
  readonly kind = "mock" as const;

  // -- projects ------------------------------------------------------------

  async projectCreate(request: ProjectCreateRequest): Promise<ProjectSessionDto> {
    const now = isoNow();
    const workspacePath = request.workspacePath || "/tmp/creativelab-mock";
    const project: EditorDocument["project"] = {
      id: newId("project"),
      schemaVersion: 1,
      title: request.title,
      fps: { num: request.fps.num, den: request.fps.den },
      width: request.width,
      height: request.height,
      colorProfile: (request.colorProfile as EditorDocument["project"]["colorProfile"]) ?? "bt709",
      sampleRate: request.sampleRate ?? 48_000,
      channels: request.channels ?? 2,
      workspaceRelPath: ".",
      createdAt: now,
      updatedAt: now,
    };
    mockState.document = createInitialDocument(project);
    mockState.workspacePath = workspacePath;
    mockState.recovery = null;
    mockState.dirty = false;
    this.#rememberRecent(project.title, workspacePath, now);
    return this.#session();
  }

  async projectOpen(request: { workspacePath: string }): Promise<ProjectSessionDto> {
    if (!mockState.document) {
      // Opening a workspace the mock has never seen behaves like creating a blank project,
      // which keeps the "[open] with no prior create" path in the UI exercisable.
      return this.projectCreate({
        title: baseName(request.workspacePath) || "Recovered Project",
        fps: { num: 30, den: 1 },
        width: 1920,
        height: 1080,
        workspacePath: request.workspacePath,
      });
    }
    mockState.workspacePath = request.workspacePath;
    return this.#session();
  }

  async projectSave(request: ProjectSaveRequest): Promise<ProjectSaveResponse> {
    const document = documentFromDto(request.document);
    mockState.document = {
      ...document,
      project: { ...document.project, updatedAt: isoNow() },
    };
    mockState.dirty = false;
    return {
      savedAt: isoNow(),
      schemaVersion: mockState.document.project.schemaVersion,
      clips: mockState.document.clips.length,
      tracks: mockState.document.tracks.length,
    };
  }

  async projectClose(): Promise<void> {
    mockState.document = null;
    mockState.workspacePath = null;
    mockState.recovery = null;
  }

  async projectListRecent(): Promise<ProjectSummaryDto[]> {
    return [...mockState.recents];
  }

  async projectPackage(request: ProjectPackageRequest): Promise<ProjectPackageResponse> {
    const unresolved = (mockState.document?.assets ?? [])
      .filter((asset) => asset.storageMode === "linked")
      .map((asset) => asset.relativePath ?? asset.uri);
    return {
      destination: request.destinationPath,
      files: 4 + (mockState.document?.assets.length ?? 0),
      bytes: 18_400_000 + (mockState.document?.assets.length ?? 0) * 1_200_000,
      unresolved,
      portable: unresolved.length === 0,
    };
  }

  async projectBackup(request: { workspacePath: string; label?: string }): Promise<{ destination: string; files: number }> {
    const label = request.label ?? "auto";
    return {
      destination: `${request.workspacePath}/backups/${label}-${Date.now()}.zip`,
      files: 3 + (mockState.document?.clips.length ?? 0),
    };
  }

  // -- workspace -----------------------------------------------------------

  async workspaceUsage(request: WorkspaceUsageRequest): Promise<WorkspaceUsageResponse> {
    const assetBytes = (mockState.document?.assets ?? []).reduce((total, asset) => total + (asset.bytes ?? 0), 0);
    const cacheBytes = 24_000_000 + mockState.proxyCount * 3_200_000;
    return {
      root: request.workspacePath,
      totalBytes: assetBytes + cacheBytes + 512_000,
      cacheBytes,
      cacheReclaimableBytes: Math.round(cacheBytes * 0.8),
      directories: [
        { path: "assets/originals", bytes: Math.round(assetBytes * 0.6), files: Math.ceil(mockState.document?.assets.length ?? 0 / 2) },
        { path: "assets/generated", bytes: Math.round(assetBytes * 0.4), files: Math.floor((mockState.document?.assets.length ?? 0) / 2) },
        { path: "cache/proxies", bytes: Math.round(cacheBytes * 0.6), files: mockState.proxyCount },
        { path: "cache/thumbnails", bytes: Math.round(cacheBytes * 0.25), files: 12 + mockState.proxyCount * 4 },
        { path: "exports", bytes: 0, files: 0 },
      ],
    };
  }

  async workspacePurgeCaches(_request: WorkspaceUsageRequest): Promise<{ purged: string[] }> {
    // The path is accepted for interface parity (and validated Rust-side in the real bridge);
    // the mock has no filesystem, so it only resets its synthetic cache counters.
    const purged = ["cache/proxies", "cache/thumbnails", "cache/waveforms"];
    mockState.proxyCount = 0;
    return { purged };
  }

  // -- assets --------------------------------------------------------------

  async assetImport(request: AssetImportRequest): Promise<AssetImportResponse> {
    const document = mockState.document;
    if (!document) throw new Error("Mock bridge: create or open a project before importing media");
    const now = isoNow();
    const imported: ImportedAssetDto[] = [];
    const errors: Array<{ path: string; message: string }> = [];

    for (const sourcePath of request.sourcePaths) {
      const mediaType = mediaTypeOf(sourcePath);
      const sha256 = hashString(sourcePath);
      const duplicate = document.assets.find((asset) => asset.sha256 === sha256) ?? null;
      const name = baseName(sourcePath);
      const fps = mediaType === "video" ? { num: 30, den: 1 } : null;
      const durationFrames =
        mediaType === "video" ? 300 : mediaType === "audio" ? 240 : mediaType === "image" ? 150 : null;

      const asset: Asset = {
        id: newId("asset"),
        projectId: document.project.id,
        mediaType,
        storageMode: request.mode === "link" ? "linked" : "copied",
        uri: sourcePath,
        relativePath:
          request.mode === "link" ? null : `assets/originals/${(document.assets.length + 1).toString().padStart(3, "0")}-${name}`,
        sha256,
        bytes: 1_200_000 + (sha256.charCodeAt(0) % 40) * 250_000,
        durationFrames,
        width: mediaType === "video" || mediaType === "image" ? (mediaType === "image" ? 1024 : 1920) : null,
        height: mediaType === "video" || mediaType === "image" ? (mediaType === "image" ? 1024 : 1080) : null,
        sampleRate: mediaType === "audio" ? 48_000 : mediaType === "video" ? 48_000 : null,
        channels: mediaType === "audio" ? 2 : mediaType === "video" ? 2 : null,
        fps,
        codec: mediaType === "video" ? "h264" : mediaType === "audio" ? "pcm_s16le" : mediaType === "image" ? "png" : null,
        container: extensionOf(sourcePath) || null,
        origin: "imported",
        parentAssetId: null,
        generationJobId: null,
        promptRevisionId: null,
        probe: { mock: true, sourcePath, sourceName: name },
        missingAt: null,
        createdAt: now,
        updatedAt: now,
      };

      document.assets = [...document.assets, asset];
      imported.push({
        asset: toAssetDto(asset),
        duplicateOf: duplicate?.id ?? null,
        warnings: request.mode === "link" ? ["Linked original: the project is not self-contained."] : [],
      });
    }

    mockState.document = { ...document, project: { ...document.project, updatedAt: now } };
    mockState.dirty = true;
    return { imported, errors };
  }

  async assetRelink(request: { workspacePath: string; assetId: string; newPath: string }): Promise<AssetDto> {
    const document = this.#requireDocument();
    const now = isoNow();
    const next = document.assets.map((asset) =>
      asset.id === request.assetId
        ? { ...asset, uri: request.newPath, relativePath: `assets/originals/${baseName(request.newPath)}`, missingAt: null, updatedAt: now }
        : asset,
    );
    mockState.document = { ...document, assets: next };
    const updated = next.find((asset) => asset.id === request.assetId);
    if (!updated) throw new Error(`Mock bridge: unknown asset ${request.assetId}`);
    return toAssetDto(updated);
  }

  async assetProbe(request: { workspacePath: string; assetId: string }): Promise<AssetDto> {
    const document = this.#requireDocument();
    const asset = document.assets.find((candidate) => candidate.id === request.assetId);
    if (!asset) throw new Error(`Mock bridge: unknown asset ${request.assetId}`);
    return toAssetDto({ ...asset, probe: { ...(asset.probe ?? {}), probedAt: isoNow(), mock: true } });
  }

  async assetDelete(request: { workspacePath: string; assetId: string }): Promise<void> {
    const document = this.#requireDocument();
    mockState.document = {
      ...document,
      assets: document.assets.filter((asset) => asset.id !== request.assetId),
      clips: document.clips.map((clip) => (clip.assetId === request.assetId ? { ...clip, assetId: null } : clip)),
    };
    mockState.dirty = true;
  }

  async mediaThumbnail(request: MediaThumbnailRequest): Promise<MediaThumbnailResponse> {
    const asset = this.#asset(request.assetId);
    const dataUri = buildThumbnailDataUri(asset, request.atSeconds);
    return {
      // The UI accepts either a workspace-relative path or a resolvable URI; the mock
      // returns a data URI so no file server is needed in the browser.
      relativePath: dataUri,
      width: request.width || THUMBNAIL_WIDTH,
      height: Math.round(((request.width || THUMBNAIL_WIDTH) * THUMBNAIL_HEIGHT) / THUMBNAIL_WIDTH),
    };
  }

  async mediaWaveform(request: MediaWaveformRequest): Promise<MediaWaveformResponse> {
    const asset = this.#asset(request.assetId);
    const buckets = Math.max(1, Math.min(2048, Math.round(request.buckets)));
    return {
      relativePath: `cache/waveforms/${asset.id}.json`,
      buckets,
      peaks: buildPeaks(asset.id, buckets),
    };
  }

  async mediaProxy(request: MediaProxyRequest): Promise<MediaProxyResponse> {
    const asset = this.#asset(request.assetId);
    mockState.proxyCount += 1;
    const sourceWidth = asset.width ?? 1920;
    const sourceHeight = asset.height ?? 1080;
    const width = Math.min(request.maxWidth, sourceWidth);
    const height = Math.round((width * sourceHeight) / sourceWidth);
    return {
      relativePath: `cache/proxies/${asset.id}-${width}.mp4`,
      width,
      height,
      bytes: Math.round(width * height * 0.12),
    };
  }

  // -- render --------------------------------------------------------------

  async renderStart(request: RenderStartRequest): Promise<RenderStartResponse> {
    const document = this.#requireDocument();
    const durationFrames = Math.max(1, sequenceDurationFrames(document.clips));
    const exportJobId = newId("exportJob");
    mockState.renders.set(exportJobId, {
      exportJobId,
      sequenceId: request.sequenceId,
      presetId: request.presetId,
      outputPath: request.outputPath,
      burnInCaptions: request.burnInCaptions ?? false,
      startedAt: mockState.now(),
      totalFrames: durationFrames,
      canceled: false,
      failed: false,
    });
    return { exportJobId, totalFrames: durationFrames };
  }

  async renderStatus(request: RenderStatusRequest): Promise<RenderStatusResponse> {
    const render = mockState.renders.get(request.exportJobId);
    if (!render) throw new Error(`Mock bridge: unknown export job ${request.exportJobId}`);
    const elapsedMs = mockState.now() - render.startedAt;
    const totalMs = Math.max(2_500, render.totalFrames * 12);
    const ratio = Math.min(1, elapsedMs / totalMs);

    let status: RenderStatusResponse["status"];
    if (render.canceled) status = "canceled";
    else if (render.failed) status = "failed";
    else if (ratio < 0.08) status = "preparing";
    else if (ratio < 0.97) status = "rendering";
    else if (ratio < 1) status = "finalizing";
    else status = "completed";

    const renderedFrames = Math.min(render.totalFrames, Math.round(render.totalFrames * ratio));
    return {
      exportJobId: render.exportJobId,
      status,
      progress: status === "completed" ? 1 : ratio,
      renderedFrames,
      totalFrames: render.totalFrames,
      logTail: mockLogTail(render, renderedFrames),
      outputPath: render.outputPath,
      errors: render.failed ? ["Mock encoder simulated a failure (FFmpeg exit code 1)."] : [],
    };
  }

  async renderCancel(request: RenderCancelRequest): Promise<void> {
    const render = mockState.renders.get(request.exportJobId);
    if (render) render.canceled = true;
  }

  // -- credentials ---------------------------------------------------------

  async credentialSet(request: CredentialSetRequest): Promise<CredentialRefDto> {
    if (!request.secret || request.secret.trim().length === 0) {
      throw new Error("Mock bridge: refusing to store an empty credential");
    }
    mockState.secrets.set(request.providerId, request.secret);
    // Note the response: a ref and a boolean. The secret itself is never echoed.
    return {
      providerId: request.providerId,
      credentialRef: `keychain://creativelab/${request.providerId}`,
      hasSecret: true,
    };
  }

  async credentialDelete(request: { providerId: string }): Promise<void> {
    mockState.secrets.delete(request.providerId);
  }

  async credentialList(): Promise<CredentialRefDto[]> {
    return [...mockState.secrets.keys()].map((providerId) => ({
      providerId,
      credentialRef: `keychain://creativelab/${providerId}`,
      hasSecret: true,
    }));
  }

  async credentialTest(request: CredentialTestRequest): Promise<CredentialTestResponse> {
    const has = mockState.secrets.has(request.providerId);
    if (!has) {
      return { ok: false, message: `No credential stored for ${request.providerId}.`, latencyMs: null };
    }
    // A test never reveals the key, not even a prefix or its length.
    return { ok: true, message: `Credential for ${request.providerId} validated.`, latencyMs: 128 };
  }

  // -- provider catalog ----------------------------------------------------

  async providerListModels(request: ProviderListModelsRequest): Promise<ProviderListModelsResponse> {
    const seed = MODEL_SEEDS.filter((model) => !request.providerId || model.providerId === request.providerId).map(
      (model) => modelDto(model, mockState.catalogFetchedAt),
    );
    return { models: seed, fetchedAt: mockState.catalogFetchedAt, errors: [] };
  }

  async providerCatalogRefresh(request: { providerId?: string }): Promise<ProviderListModelsResponse> {
    mockState.catalogFetchedAt = isoNow();
    return this.providerListModels({ providerId: request.providerId, refresh: true });
  }

  // -- jobs ----------------------------------------------------------------

  async jobList(request: JobListRequest): Promise<JobListResponse> {
    const jobs = [...mockState.jobs.values()]
      .filter((job) => !request.status || request.status.length === 0 || request.status.includes(job.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { jobs: request.limit ? jobs.slice(0, request.limit) : jobs };
  }

  async jobCancel(request: { workspacePath: string; jobId: string }): Promise<void> {
    const job = mockState.jobs.get(request.jobId);
    if (!job) throw new Error(`Mock bridge: unknown job ${request.jobId}`);
    if (job.status === "completed" || job.status === "canceled") {
      throw new Error(`Mock bridge: job ${request.jobId} is already ${job.status}`);
    }
    mockState.jobs.set(request.jobId, { ...job, status: "canceled", updatedAt: isoNow() });
  }

  async jobRetry(request: { workspacePath: string; jobId: string }): Promise<void> {
    const job = mockState.jobs.get(request.jobId);
    if (!job) throw new Error(`Mock bridge: unknown job ${request.jobId}`);
    if (job.status !== "failed") throw new Error(`Mock bridge: only failed jobs can be retried`);
    mockState.jobs.set(request.jobId, {
      ...job,
      status: "queued",
      retryCount: job.retryCount + 1,
      error: null,
      progress: 0,
      updatedAt: isoNow(),
    });
  }

  async jobReconcile(request: { workspacePath: string }): Promise<JobReconcileResponse> {
    void request;
    // PRD §12: uncertain submissions must never auto-resubmit, so `unknown` jobs with no
    // provider id are parked for a human decision instead of being resumed.
    const needsAttention: Array<{ jobId: string; reason: string }> = [];
    const resumed: string[] = [];
    for (const job of mockState.jobs.values()) {
      if (job.status === "unknown") {
        if (job.providerJobId) resumed.push(job.id);
        else needsAttention.push({ jobId: job.id, reason: "No provider job id recorded; acceptance and billing are unverified." });
      }
    }
    return { needsAttention, resumed };
  }

  /** Test/UI affordance of the mock only: fabricate a job so the queue has something to show. */
  seedJob(input: Partial<JobDto> & { providerId: string; modelId: string; modality: string; mode: string }): JobDto {
    const now = isoNow();
    const job: JobDto = {
      id: input.id ?? newId("job"),
      providerId: input.providerId,
      modelId: input.modelId,
      mode: input.mode,
      modality: input.modality,
      status: input.status ?? "queued",
      progress: input.progress ?? null,
      providerJobId: input.providerJobId ?? null,
      retryCount: input.retryCount ?? 0,
      costEstimate: input.costEstimate ?? null,
      actualCost: input.actualCost ?? null,
      outputAssetIds: input.outputAssetIds ?? [],
      error: input.error ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    mockState.jobs.set(job.id, job);
    return job;
  }

  // -- dialogs -------------------------------------------------------------

  async dialogOpenFile(request: { multiple?: boolean; filters?: FileFilter[] }): Promise<DialogResultDto> {
    void request;
    // The mock cannot show a native dialog, so it returns a plausible selection.
    return { paths: ["/Users/studio/footage/interview-take-03.mp4"], canceled: false };
  }

  async dialogOpenDirectory(request?: { title?: string }): Promise<DialogResultDto> {
    void request;
    return { paths: ["/Users/studio/CreativeLab"], canceled: false };
  }

  async dialogSaveFile(request: { defaultPath?: string }): Promise<DialogResultDto> {
    return { paths: [request.defaultPath ?? "/Users/studio/Movies/creativelab-export.mp4"], canceled: false };
  }

  // -- settings ------------------------------------------------------------

  async settingsGet(request: SettingsGetRequest): Promise<SettingsGetResponse> {
    return { value: mockState.settings.has(request.key) ? mockState.settings.get(request.key) : null };
  }

  async settingsSet(request: SettingsSetRequest): Promise<void> {
    mockState.settings.set(request.key, request.value);
  }

  /** Test hook: read a raw stored secret. Never used by UI code. */
  __secretForTests(providerId: string): string | undefined {
    return mockState.secrets.get(providerId);
  }

  // -- internals -----------------------------------------------------------

  #requireDocument(): EditorDocument {
    if (!mockState.document) throw new Error("Mock bridge: no project is open");
    return mockState.document;
  }

  #asset(assetId: string): Asset {
    const asset = this.#requireDocument().assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new Error(`Mock bridge: unknown asset ${assetId}`);
    return asset;
  }

  #session(): ProjectSessionDto {
    const document = this.#requireDocument();
    return {
      document: toDocumentDto(document),
      workspacePath: mockState.workspacePath ?? "/tmp/creativelab-mock",
      schemaVersion: document.project.schemaVersion,
      recovery: mockState.recovery,
    };
  }

  #rememberRecent(title: string, workspacePath: string, updatedAt: string): void {
    mockState.recents = [
      { id: newId("project"), title, workspacePath, updatedAt, hasMissingMedia: false },
      ...mockState.recents.filter((entry) => entry.workspacePath !== workspacePath),
    ].slice(0, 8);
  }
}

// ---------------------------------------------------------------------------
// Synthetic media generators
// ---------------------------------------------------------------------------

/**
 * Build a small PNG data URI. Uses `OffscreenCanvas`/`<canvas>` when present (browser and
 * webview) and falls back to a 1x1 transparent PNG in non-DOM environments such as the
 * Node test run — the point is a *resolvable* image, not a pretty one.
 */
export function buildThumbnailDataUri(asset: Asset, atSeconds: number): string {
  const width = THUMBNAIL_WIDTH;
  const height = THUMBNAIL_HEIGHT;
  const canvas = createCanvas(width, height);
  if (!canvas) return TRANSPARENT_PNG;
  const context = canvas.getContext("2d");
  if (!context) return TRANSPARENT_PNG;
  const paint = (): void => {
    context.clearRect(0, 0, width, height);
    if (asset.mediaType === "audio") {
      context.fillStyle = "#1b2430";
      context.fillRect(0, 0, width, height);
      context.strokeStyle = "#4ade80";
      context.beginPath();
      const peaks = buildPeaks(asset.id, 48);
      peaks.forEach((pair, index) => {
        const peak = Math.max(Math.abs(pair[0] ?? 0), Math.abs(pair[1] ?? 0));
        const x = (index / peaks.length) * width;
        const amplitude = peak * (height / 2);
        context.moveTo(x, height / 2 - amplitude);
        context.lineTo(x, height / 2 + amplitude);
      });
      context.stroke();
      return;
    }
    const seed = hashSeed(`${asset.id}:${Math.round(atSeconds * 10)}`);
    const random = pseudoRandom(seed);
    const hue = Math.round(random() * 320);
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, `hsl(${hue} 45% 26%)`);
    gradient.addColorStop(1, `hsl(${(hue + 48) % 360} 55% 14%)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.fillStyle = "rgba(255,255,255,0.16)";
    for (let i = 0; i < 5; i += 1) {
      const w = 12 + random() * 46;
      const h = 8 + random() * 40;
      context.fillRect(random() * (width - w), random() * (height - h), w, h);
    }
    context.fillStyle = "rgba(255,255,255,0.75)";
    context.font = "600 11px system-ui, sans-serif";
    context.fillText(asset.mediaType.toUpperCase(), 8, height - 8);
  };
  paint();
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return TRANSPARENT_PNG;
  }
}

interface MinimalCanvas {
  width: number;
  height: number;
  getContext(id: "2d"): CanvasRenderingContext2D | null;
  toDataURL(type?: string): string;
}

function createCanvas(width: number, height: number): MinimalCanvas | null {
  const Offscreen = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  if (typeof Offscreen === "function") {
    const canvas = new (Offscreen as new (w: number, h: number) => MinimalCanvas)(width, height);
    return canvas;
  }
  const doc = (globalThis as { document?: Document }).document;
  if (doc) {
    const canvas = doc.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as MinimalCanvas;
  }
  return null;
}

function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 1x1 transparent PNG, the non-DOM fallback for `buildThumbnailDataUri`. */
const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Interleaved min/max pairs in [-1, 1], matching `MediaWaveformResponse.peaks`. */
export function buildPeaks(seed: string, buckets: number): number[][] {
  const random = pseudoRandom(hashSeed(seed));
  const peaks: number[][] = [];
  let envelope = 0.9;
  for (let i = 0; i < buckets; i += 1) {
    envelope = Math.max(0.08, Math.min(1, envelope + (random() - 0.5) * 0.22));
    const min = -envelope * (0.6 + random() * 0.4);
    const max = envelope * (0.6 + random() * 0.4);
    peaks.push([Number(min.toFixed(4)), Number(max.toFixed(4))]);
  }
  return peaks;
}

function mockLogTail(render: MockRender, renderedFrames: number): string[] {
  const fps = frameRateAsNumber({ num: 30, den: 1 });
  const seconds = renderedFrames / fps;
  return [
    `ffmpeg version 7.1 Copyright (c) 2000-2025 the FFmpeg developers`,
    `Input #0, mov,mp4,m4a from 'mock-input'`,
    `Stream #0:0: Video: h264, yuv420p, ${render.presetId}`,
    `Stream #0:1: Audio: aac, 48000 Hz, stereo`,
    `frame=${renderedFrames} fps=${fps} time=${seconds.toFixed(2)} bitrate=11840kbits/s speed=1.4x`,
    render.burnInCaptions ? `burn-in captions enabled` : `burn-in captions disabled`,
    `Output: ${render.outputPath}`,
  ];
}
