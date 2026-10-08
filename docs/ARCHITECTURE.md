# Architecture

> Local-First AI Creative Studio — implementation notes for contributors.
> Requirements source of truth: [`PRD.md`](./PRD.md).

## Repository layout

```
packages/core        @creativelab/core        domain: time, project document, timeline, jobs, storage
packages/media       @creativelab/media       ffprobe/FFmpeg: probe, thumbnails, waveforms, proxies, export
packages/providers   @creativelab/providers   capability-based AI provider adapters, catalog, cost
apps/desktop         @creativelab/desktop     Tauri 2 shell + React webview UI
apps/desktop/src-tauri                       Rust: allowlisted IPC, keychain, SQLite, process spawning
tools/cli            @creativelab/cli       headless driver + asserted end-to-end journey
tools/github                                 PRD-derived backlog generator
```

## Layering rules

1. `core` depends on nothing but Node built-ins and `zod`. It never touches the network,
   the DOM or Tauri.
2. `media` and `providers` depend on `core` only.
3. The React UI depends on `core` **types and pure functions** only, resolved through the
   isomorphic `@creativelab/core/browser` entry point. Everything privileged (filesystem,
   process spawning, keychain, network) goes through the `StudioBridge` IPC interface defined
   in `apps/desktop/src/bridge/`.

   Why a separate entry point: the main barrel re-exports `workspace.ts`, `migrations.ts`,
   `session.ts` and the SQLite store, which import `node:fs`/`node:sqlite` and cannot be
   bundled for a webview. `browser.ts` exports only the platform-neutral modules (time, ids,
   errors, schema, timeline, history, jobs, budget) so the renderer runs the _same_ timeline
   algebra and budget gate the host runs — no mirrored logic to drift. Two things keep that
   honest: `packages/core/src/browser.test.ts` walks the module graph and fails if any Node
   built-in is reachable, and the `vite build` step in CI proves the bundle actually resolves.

   The single pre-existing exception was `ids.ts`, which imported `node:crypto`; it now uses
   the Web Crypto API, which exists in Node 22+ and in the Tauri webview.

4. Rust never duplicates domain logic. It owns: windowing, the allowlist, the OS
   keychain, SQLite via `rusqlite` (same migration files), and child processes.

## Invariants that must not be broken

| Invariant                                                                    | Why                                                            |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Timeline coordinates are integer frames, never float seconds                 | PRD §10; drift-free A/V sync                                   |
| All timeline edits are pure functions returning new objects                  | makes undo/redo and autosave snapshots correct by construction |
| Every filesystem path goes through `safeJoin`/`assertInside`                 | PRD §13 path scoping                                           |
| Child processes are spawned with an argument **array**, never a shell string | PRD §13 "no shell injection"                                   |
| API keys live only in the OS keychain, referenced by opaque `credentialRef`  | PRD §13                                                        |
| Media file bytes are never modified in place                                 | PRD §4 non-destructive editing                                 |
| A job in `submitting` after a restart becomes `unknown`, never auto-retried  | PRD §12 duplicate-charge protection                            |

## `@creativelab/core` — public surface

```ts
// timebase.ts
frameRate(num, den): FrameRate
framesToSeconds / secondsToFrames / framesToMs / msToFrames / convertFrames / retimeDuration
formatTimecode / parseTimecode / framesToTimecodeParts / framesToClock
FRAME_RATE_PRESETS, nominalFps, supportsDropFrame, dropFrameCount, rational

// schema.ts   (zod schemas + inferred types)
Project, Sequence, Track, Clip, Effect, Keyframe, Asset, GenerationJob, PromptRevision,
ExportJob, ProviderConfig, EditorDocument, ProjectManifest
ClipProperties, Transform, Crop, AudioProperties, Transition, ExportPreset
EXPORT_PRESETS, ASPECT_PRESETS, TRACK_LIMITS, SCHEMA_VERSION, MANIFEST_VERSION, JOB_STATUSES

// timeline.ts (pure operations on readonly Clip[] / EditorDocument)
clipEnd, clipRange, sourceRange, sourceSpan, rangesOverlap, clipsOnTrack, clipsInRange,
clipAtFrame, sequenceDurationFrames, detectOverlaps, assertTimelineInvariants,
collectSnapTargets, snapFrame, snapClipMove,
splitClip, trimClip, moveClip, deleteClips, closeGaps, duplicateClips, setClipProperties,
sortClips, createTrack, addTrack, removeTrack, updateTrack, reorderTrack,
createInitialDocument, createEffect, mergeRanges, sequenceFrameRate, isoNow

// history.ts
History<T>  // push(label, next, {coalesce}), undo(), redo(), state, undoLabels()

// jobs.ts
JOB_TRANSITIONS, canTransition, assertTransition, isTerminal, isPollable,
nextBackoffDelay, decideRetry, DEFAULT_RETRY_POLICY,
claimSubmission, reconcileAfterRestart, jobsDueForPoll, countInFlight, scheduleNextPoll

// budget.ts
BudgetPolicy, DEFAULT_BUDGET_POLICY, evaluateBudget, assertBudget, dayKey,
spendOn, addMoney, roundMoney, formatMoney, normalizeCost

// migrations.ts
Migration, MigrationDriver, runMigrations, loadMigrationsFromDisk, migrationChecksum,
currentSchemaVersion, validateMigrations, MigrationError

// workspace.ts
WORKSPACE_DIRS, REBUILDABLE_DIRS, MANIFEST_FILENAME, DATABASE_FILENAME,
openWorkspace, makeWorkspace, Workspace, WorkspaceLayout,
assertSafeRelativePath, assertInside, isInside, safeJoin, sanitizeFileName, uniqueFileName,
atomicWriteFile, atomicWriteJson, readJsonFile, pathExists, hashFile, hashBytes,
toProjectRelative, fromProjectRelative, planImportDestination,
directoryUsage, workspaceUsage, purgeCaches, createBackup

// manifest.ts
buildManifest, manifestToDocument, serializeManifest, parseManifest, readManifest,
writeManifest, verifyAssets, RelinkReport, AssetIssue, ManifestError

// session.ts
ProjectSession.create(options, input) / .open(options)
  .document .dirty .applyEdit(label, fn, {coalesce}) .undo() .redo()
  .save() .scheduleAutosave() .flushAutosave()
  .writeCrashSnapshot(reason) .findRecoverableSnapshot() .recoverFromSnapshot(path)
  .verifyAssets() .relinkAsset(id, path) .packageProject(dest) .close()

// store/
ProjectStore (interface), CreateProjectInput, JobEvent, ModelCatalogEntry, SaveResult
SqliteProjectStore, SqliteDriver, openMemoryDatabase
```

### Creating a session (the canonical bootstrap)

```ts
import {
  openWorkspace,
  SqliteProjectStore,
  SqliteDriver,
  runMigrations,
  ProjectSession,
} from "@creativelab/core";

const workspace = await openWorkspace(projectDir);
const store = new SqliteProjectStore({ filename: workspace.layout.databasePath });
const session = await ProjectSession.open({ workspace, store, migrations });
```

## `@creativelab/media` — required surface

```ts
probeMedia(filePath, options?): Promise<MediaProbe>
// MediaProbe: { container, durationSeconds, durationFrames(fps), streams: MediaStreamInfo[],
//               video?: {width,height,fps:FrameRate,codec,pixFmt,bitrate,rotation},
//               audio?: {codec,sampleRate,channels,bitrate}, raw: unknown }

extractThumbnail(filePath, { timeSeconds, width, outPath, format }): Promise<ThumbnailResult>
extractWaveform(filePath, { buckets, sampleRate? }): Promise<WaveformData>
// WaveformData: { buckets: number, peaks: {min:number;max:number}[] }  // values in [-1,1]

createProxy(filePath, { outPath, maxWidth, crf, onProgress, signal }): Promise<ProxyResult>
runFfmpeg(args, { onProgress, signal, timeoutMs }): Promise<FfmpegResult>   // spawn(array), never shell
buildExportGraph(document, { preset, outputPath, assets, onProgress, signal }): Promise<ExportResult>
// Renders the timeline to H.264/AAC MP4 with progress + cancellation.
```

Hard requirements:

- `spawn` with an argument array. No `exec`, no `shell: true`, no string interpolation.
- Parse FFmpeg `-progress pipe:1` output for `frame=`/`out_time_ms=` to drive progress.
- Cancellation sends `SIGTERM`, waits, then `SIGKILL`.
- Temp output file + atomic rename on success (PRD §12).
- Non-zero exit surfaces FFmpeg's last stderr lines in the error.
- **Export renders at the sequence frame rate.** `ExportPreset.fps` is `null` for every
  shipped preset, which means "use the project's rate" (PRD §12: "export always renders at
  project settings"). An explicit preset rate is a deliberate delivery conversion, not the
  default, because resampling here would silently change the frame count and break
  preview/export parity (FR-04).
- **Media with no audio stream is not an error.** A video-only file yields a flat waveform;
  only a file that cannot be probed at all raises. Conflating those would either fail a
  valid import or hide real corruption.

## The composition contract (preview/export parity)

`packages/media/src/graph.ts` and `apps/desktop/src-tauri/src/render.rs` both implement this
spec, and the browser preview in `apps/desktop/src/components/composeFrame.ts` mirrors it.
They are kept in step by (a) this written spec, (b) tests in both languages asserting the
same expected filter string for the same fixture timeline, and (c) golden-frame comparison.

Per video clip, in track `sortOrder` order (lowest first, so higher tracks composite on top):

```
[i:v]trim=start=…:duration=…,setpts=(PTS-STARTPTS)/<speed>,
     scale=W:H:force_original_aspect_ratio=decrease,
     pad=W:H:(ow-iw)/2:(oh-ih)/2,
     crop=…,rotate=…:ow=rotw(…):oh=roth(…):c=none,format=rgba,
     colorchannelmixer=aa=<opacity>[vN]
```

then `[base][vN]overlay=x=(W-w)/2+tx:y=(H-h)/2+ty:enable='between(t,start,end)'[base]`.

Per audio clip: `atrim` → `asetpts=PTS-STARTPTS` → chained `atempo` → `adelay` → `volume` →
`afade`, mixed with `amix=inputs=N:normalize=0:dropout_transition=0`.

Rules that both sides must honour:

| Rule                                                                               | Why                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Stage order is frozen                                                              | A different order changes the pixels                                                 |
| **Identity stages are omitted**                                                    | A graph of no-ops is unreadable and hides real changes in review                     |
| `rotation` is **degrees clockwise**; emit positive radians                         | The `rotate` filter is clockwise for positive radians, and the schema says clockwise |
| `rotw(a)`/`roth(a)` take an **angle**, not a size                                  | `rotw(iw)` silently computes a nonsense bounding box                                 |
| Numbers use `toFixed(6)` with trailing zeros stripped, `-0` → `0`                  | So the two implementations stay diffable                                             |
| Crop is clamped to ≥1 px                                                           | `crop=0` is invalid and would fail the render                                        |
| Track `hidden` skips video, `muted`/disabled audio is skipped, `solo` mutes others | Otherwise the export shows something the preview does not                            |

**Known gap:** the graph does not yet read `document.effects` or `document.keyframes`, so
clip effects and keyframes are stored and listed but inert. The Inspector discloses this
rather than silently accepting them; FR-12 tracks the work.

## `@creativelab/providers` — required surface

```ts
// The PRD §8 adapter contract, exactly:
interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  listModels(ctx): Promise<ModelDescriptor[]>;
  describeCapabilities(modelId): Promise<ModelCapabilities>;
  estimateCost(request): Promise<Spend | null>;
  validate(request, capabilities): ValidationResult;
  submit(request, ctx): Promise<SubmitResult>; // { providerJobId?, status, outputs? }
  getJob(jobId, ctx): Promise<JobStatusResult>; // { status, progress?, outputs?, cost? }
  cancel(jobId, ctx): Promise<void>;
  fetchOutputs(job, ctx): Promise<RemoteOutput[]>;
  normalizeError(error): CreativeLabError;
}
```

`ModelCapabilities` must carry every field listed in PRD §8: `modality`, `modes`,
`inputMimeTypes`, `aspectRatios`, `resolutions`, `durationMinSeconds`,
`durationMaxSeconds`, `supportsSeed`, `supportsNegativePrompt`, `referenceFrame`
(`none|optional|required`), `supportsAudio`, `voices`, `languages`, `maxConcurrency`,
`pricing`, `quota`, `safety`.

**Unknown features must be hidden or disabled, never silently ignored** — that rule is
enforced by `validate()` returning per-field `unsupported` reasons.

Credential access goes through:

```ts
interface CredentialVault {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, secret: string): Promise<void>;
  delete(ref: string): Promise<void>;
  list(): Promise<string[]>;
}
```

`MemoryCredentialVault` for tests; `TauriCredentialVault` in the app; keys must never be
logged, serialized into a project, or attached to an error object.

## Desktop IPC allowlist

The renderer may only call these commands. Anything else is rejected.

```
project_create, project_open, project_save, project_close, project_list_recent
project_package, project_backup, workspace_usage, workspace_purge_caches
asset_import, asset_relink, asset_probe, asset_delete
media_thumbnail, media_waveform, media_proxy
render_start, render_cancel, render_status
credential_set, credential_delete, credential_list, credential_test
provider_list_models, provider_catalog_refresh
job_list, job_cancel, job_retry, job_reconcile
dialog_open_file, dialog_open_directory, dialog_save_file
settings_get, settings_set
```

Every command validates its arguments and resolves paths through the workspace root.

## Testing conventions

- Unit tests live next to the source as `*.test.ts` and run under Vitest from the repo
  root (`pnpm test`). `tools/cli/test/**` is included in the same run.
- Cross-package imports in tests resolve to package **source** via `vitest.config.ts`
  aliases, so tests never depend on a build having run.
- HTTP is always mocked: adapters take an injectable `fetch`, so no test touches the
  network.
- FFmpeg tests generate their own tiny fixtures with `ffmpeg -f lavfi` and skip
  gracefully when the binary is missing.
- Golden-frame export tests compare mean absolute pixel difference against a tolerance,
  not exact bytes, because H.264 encoders differ between builds.
