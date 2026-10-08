#!/usr/bin/env node
/**
 * Create the PRD-derived GitHub backlog.
 *
 * Every issue is traceable to a specific section of `docs/PRD.md`, and the blocking
 * relationships mirror the dependency structure the PRD itself implies (an editor that
 * cannot persist a project cannot be tested for timeline editing; providers cannot be
 * configured before the keychain-backed settings surface exists; and so on).
 *
 * Uses two GitHub APIs beyond plain issue creation:
 *   * sub-issues     — epic -> functional requirement hierarchy
 *   * issue dependencies (`blocked_by`) — the real dependency graph, not just prose
 *
 * Idempotent: issues are matched by title, so re-running only adds what is missing.
 *
 *   node tools/github/create-backlog.mjs --repo owner/name [--dry-run] [--skip-hierarchy]
 */
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

const PRD = "docs/PRD.md";

/** Anchor slugs are stable as long as the PRD headings do not change. */
const SECTION = {
  metrics: `${PRD}#2-goals-and-success-metrics`,
  scope: `${PRD}#4-scope-and-boundaries`,
  journeys: `${PRD}#5-primary-user-journeys`,
  ui: `${PRD}#6-experience-and-ui-specification`,
  fr: `${PRD}#7-functional-requirements-and-acceptance-criteria`,
  providers: `${PRD}#8-provider-strategy-and-compatibility`,
  architecture: `${PRD}#9-system-architecture`,
  data: `${PRD}#10-data-model`,
  filesystem: `${PRD}#11-local-project-filesystem`,
  jobs: `${PRD}#12-background-processing-and-rendering`,
  security: `${PRD}#13-security-privacy-and-policy-requirements`,
  performance: `${PRD}#14-performance-and-resilience`,
  milestones: `${PRD}#15-delivery-milestones-and-dependencies`,
  epics: `${PRD}#16-implementation-backlog-epics`,
  testPlan: `${PRD}#17-test-plan-and-definition-of-done`,
  risks: `${PRD}#18-risks-and-trade-offs`,
  open: `${PRD}#19-open-decisions`,
};

const MILESTONES = [
  {
    title: "Phase 0 — Foundation",
    description:
      "Tauri shell, workspace, SQLite migrations, project serialization, media probe, provider contract. Release gate: create-save-reopen and media ingestion reliable.",
  },
  {
    title: "Phase 1 — Usable editor",
    description:
      "Timeline, preview, inspector, import, undo/redo, proxy jobs, MP4 render. Release gate: a user edits an imported 60-second project and exports it correctly.",
  },
  {
    title: "Phase 2 — AI creation",
    description:
      "Vercel AI Gateway, ElevenLabs, first video adapter, generation queue, model capabilities. Release gate: all core modalities generate and persist to the media library.",
  },
  {
    title: "Phase 3 — Polished MVP",
    description:
      "Storyboards, voice-over, caption workflow, cost budgets, templates, packaging. Release gate: brief-to-export demo and recovery tests pass.",
  },
  {
    title: "Phase 4 — Advanced",
    description:
      "Keyframes, expanded transitions, smarter AI editing, more providers, local inference exploration. Post-MVP, driven by user feedback.",
  },
];

const LABELS = [
  { name: "epic", color: "5319e7", description: "A PRD §16 implementation epic" },
  { name: "requirement", color: "1d76db", description: "A PRD §7 functional requirement" },
  { name: "P0", color: "b60205", description: "MVP blocker — must ship" },
  { name: "P1", color: "d93f0b", description: "Post-MVP but planned" },
  { name: "P2", color: "fbca04", description: "Exploratory / later" },
  { name: "phase-0", color: "0e8a16", description: "Phase 0 — foundation" },
  { name: "phase-1", color: "0e8a16", description: "Phase 1 — usable editor" },
  { name: "phase-2", color: "0e8a16", description: "Phase 2 — AI creation" },
  { name: "phase-3", color: "0e8a16", description: "Phase 3 — polished MVP" },
  { name: "phase-4", color: "0e8a16", description: "Phase 4 — advanced" },
  { name: "core", color: "c2e0c6", description: "packages/core — domain and persistence" },
  { name: "media", color: "c2e0c6", description: "packages/media — FFmpeg pipeline" },
  { name: "providers", color: "c2e0c6", description: "packages/providers — AI adapters" },
  { name: "ui", color: "c2e0c6", description: "apps/desktop — React webview" },
  { name: "host", color: "c2e0c6", description: "apps/desktop/src-tauri — Rust host" },
  { name: "quality", color: "bfd4f2", description: "Testing, fixtures, golden frames" },
  { name: "security", color: "d4c5f9", description: "PRD §13 requirements" },
  { name: "docs", color: "0075ca", description: "Documentation and disclosure" },
  { name: "decision", color: "f9d0c4", description: "An open decision from PRD §19" },
];

/** Acceptance criteria are copied from the PRD §7 table so the issue is self-contained. */
const FUNCTIONAL_REQUIREMENTS = [
  {
    key: "FR-01",
    priority: "P0",
    title: "FR-01 — Projects and snapshots",
    epic: "A/B",
    milestone: "Phase 0 — Foundation",
    labels: ["P0", "core"],
    blockedBy: ["EPIC-B"],
    body: `Create/open/rename/duplicate/save a project; save is atomic; undo/redo survives during
the session; the last autosave is recoverable after a crash.`,
    criteria: [
      "Create, open, rename, duplicate and save a project from the UI and the CLI",
      "Save writes SQLite and `project.json` atomically — a killed process never leaves a partially written project",
      "Undo/redo survives for the whole session with labels on each step",
      "Crash recovery offers the last unsaved snapshot on next launch",
      "100 consecutive create/save/reopen cycles complete with no broken references",
    ],
  },
  {
    key: "FR-02",
    priority: "P0",
    title: "FR-02 — Local media library",
    epic: "B/D",
    milestone: "Phase 0 — Foundation",
    labels: ["P0", "core", "media"],
    blockedBy: ["EPIC-D"],
    body: `Import common video, image and audio formats; probe metadata; detect missing paths;
deduplicate by content hash.`,
    criteria: [
      "Import MP4/MOV/WEBM, PNG/JPEG/WEBP and WAV/MP3",
      "ffprobe metadata is normalized into the asset record (duration, dimensions, codec, rational fps, sample rate, channels)",
      "Duplicate content is detected by sha256 and reuses the existing asset",
      "Deleted or moved media is surfaced as missing with a relink action",
      "Imports are copied into the project by default; linked originals are an explicit advanced choice",
    ],
  },
  {
    key: "FR-03",
    priority: "P0",
    title: "FR-03 — Timeline editing",
    epic: "C",
    milestone: "Phase 1 — Usable editor",
    labels: ["P0", "core", "ui"],
    blockedBy: ["FR-01"],
    body: `Non-linear multi-track editing that never touches the source media: split, trim, move,
overlap, snap and reorder across at least 3 video and 4 audio tracks.`,
    criteria: [
      "At least 3 video and 4 audio tracks, with add/remove/reorder",
      "Split, trim, move, overlap, snap and reorder all work without modifying source files",
      "Overwrite, insert (ripple) and replace edit modes behave correctly",
      "Timeline coordinates are integer frames; a non-integer or overlapping state is rejected before it is applied",
      "Every operation is a pure function returning a new document, so undo restores exact geometry",
    ],
  },
  {
    key: "FR-04",
    priority: "P0",
    title: "FR-04 — Preview and playback",
    epic: "C",
    milestone: "Phase 1 — Usable editor",
    labels: ["P0", "ui"],
    blockedBy: ["FR-03", "FR-02"],
    body: `The canvas preview composition must match the rendered output for positioning and basic
transforms, and must stay responsive with proxy media.`,
    criteria: [
      "Preview and export share one composition spec (position, scale, rotation, crop, opacity)",
      "Golden-frame tests compare preview against exported frames within tolerance",
      "Proxies are used for heavier sources so drag/scrub stays under ~100 ms on a representative 1080p project",
      "Safe-area and aspect presets (16:9, 9:16, 1:1) render correctly",
    ],
  },
  {
    key: "FR-05",
    priority: "P0",
    title: "FR-05 — Video generation",
    epic: "F",
    milestone: "Phase 2 — AI creation",
    labels: ["P0", "providers"],
    blockedBy: ["FR-08"],
    body: `Run text-to-video and image-to-video against selected supported models, with async status
tracking and the result persisted as a first-class library asset.`,
    criteria: [
      "Text-to-video and image-to-video submit through a capability-validated adapter",
      "Async jobs poll with exponential backoff and jitter, honouring provider Retry-After",
      "Downloaded output is verified, committed atomically and appears in the media library",
      "The generated asset retains model, prompt, parameters, seed, job state and cost",
      "Unsupported modes are disabled in the UI rather than silently dropped",
    ],
  },
  {
    key: "FR-06",
    priority: "P0",
    title: "FR-06 — Image generation and editing",
    epic: "F",
    milestone: "Phase 2 — AI creation",
    labels: ["P0", "providers"],
    blockedBy: ["FR-08"],
    body: `Generate new images, create variants and edit using a reference image where the model
supports it.`,
    criteria: [
      "Text-to-image generates and persists an asset",
      "Variants are linked to their parent asset through the provenance graph",
      "Reference-image editing is offered only when the capability declares it",
      "Prompt history is preserved so any variant can be regenerated or re-parameterised",
    ],
  },
  {
    key: "FR-07",
    priority: "P0",
    title: "FR-07 — Audio generation",
    epic: "F",
    milestone: "Phase 2 — AI creation",
    labels: ["P0", "providers"],
    blockedBy: ["FR-08"],
    body: `Create spoken narration and sound effects, music when the provider supports it, with
waveform display and timing controls.`,
    criteria: [
      "Text-to-speech produces narration with a selected voice and language",
      "Sound-effect generation works where supported; music generation is enabled only when declared",
      "Waveforms are extracted and rendered on the timeline clip",
      "A single sentence can be regenerated without discarding the other revisions",
      "Voice/language options come from the live model catalog, not a hard-coded list",
    ],
  },
  {
    key: "FR-08",
    priority: "P0",
    title: "FR-08 — Provider settings",
    epic: "E",
    milestone: "Phase 2 — AI creation",
    labels: ["P0", "providers", "host", "security"],
    blockedBy: ["EPIC-A"],
    body: `Configure gateway and direct provider credentials in the OS credential vault, validate the
connection, and discover available models with their capability settings.`,
    criteria: [
      "Keys are written to the OS keychain and referenced by opaque handle only",
      "No key appears in the database, the webview, a log line or an exported project",
      "Connection validation reports success or failure with latency",
      "The live model catalog is cached locally with a last-refreshed timestamp and a manual refresh",
      "A failed catalog refresh marks entries stale instead of emptying the list",
    ],
  },
  {
    key: "FR-09",
    priority: "P0",
    title: "FR-09 — Export",
    epic: "G",
    milestone: "Phase 1 — Usable editor",
    labels: ["P0", "media"],
    blockedBy: ["FR-03", "FR-04"],
    body: `Render the timeline to H.264/AAC MP4 at 720p or 1080p with progress, cancellation and
logs.`,
    criteria: [
      "A 10-minute mixed-media timeline exports with synchronized audio and no missing frames",
      "Progress is reported per frame and the export can be cancelled cleanly",
      "Output is written to a temp file and atomically renamed on success",
      "Export renders from originals at project settings, never from proxies",
      "The FFmpeg log tail is visible in the export console, and failures are actionable",
    ],
  },
  {
    key: "FR-10",
    priority: "P0",
    title: "FR-10 — Jobs and budgets",
    epic: "E",
    milestone: "Phase 2 — AI creation",
    labels: ["P0", "core", "providers"],
    blockedBy: ["FR-08"],
    body: `Queue remote generation work, cancel where supported, retry transient failures, poll
remote jobs, and avoid duplicate charges.`,
    criteria: [
      "Persistent queue with the nine PRD states: queued, validating, submitting, running, downloading, completed, failed, canceled, unknown",
      "Exponential backoff with jitter, honouring provider Retry-After and a bounded retry budget",
      "Idempotency keys plus a local submission lock collapse a double-click into one charge",
      "A submission whose outcome is unknown is never auto-resubmitted — it is parked for reconciliation",
      "Cost caps per job, a daily ceiling and an approval threshold are enforced before submission",
    ],
  },
  {
    key: "FR-11",
    priority: "P1",
    title: "FR-11 — Captions",
    epic: "G",
    milestone: "Phase 3 — Polished MVP",
    labels: ["P1", "ui", "providers"],
    blockedBy: ["FR-07", "FR-03"],
    body: `Speech-to-text with editable word and segment timing, SRT export and burn-in captions.`,
    criteria: [
      "Transcription produces editable segments with timing",
      "Timings can be corrected in the UI and the waveform reflects the change",
      "SRT export round-trips into the project",
      "Burn-in captions render identically in preview and export",
    ],
  },
  {
    key: "FR-12",
    priority: "P1",
    title: "FR-12 — Advanced editor",
    epic: "C",
    milestone: "Phase 3 — Polished MVP",
    labels: ["P1", "core", "ui"],
    blockedBy: ["FR-03"],
    body: `Keyframes, transitions, clip effects, fades, clip grouping, nesting and reusable
templates.`,
    criteria: [
      "Keyframes interpolate a property across a clip with selectable easing",
      "Transition presets apply at clip boundaries and render correctly",
      "Fades and clip effects are non-destructive and reversible",
      "Templates can be saved and re-applied to a new project",
    ],
  },
  {
    key: "FR-13",
    priority: "P1",
    title: "FR-13 — AI assistant",
    epic: "F",
    milestone: "Phase 3 — Polished MVP",
    labels: ["P1", "providers", "ui"],
    blockedBy: ["FR-05", "FR-06", "FR-07"],
    body: `Suggest a storyboard, captions, cuts and timing; preview the diff and require an explicit
apply.`,
    criteria: [
      "Suggestions are shown as a diff against the current timeline",
      "Nothing is applied to the timeline without explicit user confirmation",
      "Every applied suggestion lands as one undoable history step",
      "The assistant cannot silently spend money: any generation it proposes goes through the budget gate",
    ],
  },
  {
    key: "FR-14",
    priority: "P2",
    title: "FR-14 — Local inference",
    epic: "F",
    milestone: "Phase 4 — Advanced",
    labels: ["P2", "providers"],
    blockedBy: ["FR-08"],
    body: `Pluggable on-device models for selected operations, without changing the project schema.`,
    criteria: [
      "A local inference backend implements the same ProviderAdapter contract",
      "Selecting a local model requires no project migration",
      "Offline generation for supported operations is possible with no network",
      "Model weights are never bundled with the application distribution",
    ],
  },
];

const EPICS = [
  {
    key: "EPIC-A",
    title: "EPIC A — Desktop infrastructure",
    milestone: "Phase 0 — Foundation",
    labels: ["epic", "P0", "host"],
    blockedBy: [],
    body: `Bootstrapping, native permissions, CI installers and opt-in crash reporting.

The Tauri 2 shell exists so that everything else can be built without the renderer ever
touching the filesystem, the keychain or a child process directly.`,
    criteria: [
      "Tauri 2 macOS app builds and launches with a Vite + React + TypeScript webview",
      "IPC is an allowlist: a command not on the list is rejected, and every argument is validated",
      "File access is scoped to an approved workspace root, with traversal and symlink escapes rejected",
      "CI produces a signed-able macOS bundle (see the installer issue for Windows/Linux)",
      "Crash reporting is opt-in and off by default",
    ],
  },
  {
    key: "EPIC-B",
    title: "EPIC B — Persistence",
    milestone: "Phase 0 — Foundation",
    labels: ["epic", "P0", "core"],
    blockedBy: ["EPIC-A"],
    body: `Project schema, SQLite migrations, asset manager, relative URIs, autosave and history.`,
    criteria: [
      "Versioned, transactional, checksummed migrations shared verbatim by the TypeScript store and the Rust host",
      "`project.json` manifest uses project-relative references and can rehydrate a project with no database",
      "Assets are immutable and content-addressed; provenance links variants to their originals",
      "Autosave is debounced and crash snapshots are written periodically",
      "`Package Project` copies every dependency and validates that the copy relinks",
    ],
  },
  {
    key: "EPIC-C",
    title: "EPIC C — Timeline",
    milestone: "Phase 1 — Usable editor",
    labels: ["epic", "P0", "core", "ui"],
    blockedBy: ["EPIC-B"],
    body: `Timebase utility, clips and tracks, transforms, snapping, interactions, keyboard and
selection.`,
    criteria: [
      "Integer-frame timebase with exact rational rates, including drop-frame timecode at 29.97/59.94",
      "All edit operations are pure and validated against timeline invariants",
      "Snapping targets clip edges, the playhead and markers, with head/tail preference",
      "Keyboard transport and editing (space, J/K/L, S, Cmd/Ctrl+Z, +/-, delete, multi-select)",
    ],
  },
  {
    key: "EPIC-D",
    title: "EPIC D — Render and media",
    milestone: "Phase 1 — Usable editor",
    labels: ["epic", "P0", "media"],
    blockedBy: ["EPIC-B"],
    body: `ffprobe, thumbnails, waveforms, FFmpeg transcodes, preview/export parity, progress and
cancel.`,
    criteria: [
      "Probing normalizes metadata into the asset model, including rational frame rates and rotation",
      "Thumbnails, waveforms and proxies are generated in the background into the cache directory",
      "Child processes are spawned with argument arrays — never a shell string",
      "Renders stream progress and cancel cleanly (SIGTERM, then SIGKILL)",
      "Preview and export share one composition spec, verified by golden frames",
    ],
  },
  {
    key: "EPIC-E",
    title: "EPIC E — Providers",
    milestone: "Phase 2 — AI creation",
    labels: ["epic", "P0", "providers"],
    blockedBy: ["EPIC-A"],
    body: `Registry, capability discovery, secure credentials, adapters, cost estimation and remote
jobs.`,
    criteria: [
      "The PRD §8 adapter contract is implemented exactly, with an injectable `fetch` for tests",
      "Capabilities cover every field in the PRD §8 schema, and unsupported features are reported explicitly",
      "Credentials live in the OS keychain behind a `CredentialVault` interface and never leak into logs or errors",
      "Rate limits, timeouts, malformed responses and expiring output URLs are handled",
      "Contract tests run against every adapter with mocked HTTP and no network",
    ],
  },
  {
    key: "EPIC-F",
    title: "EPIC F — Creative AI",
    milestone: "Phase 2 — AI creation",
    labels: ["epic", "P0", "providers", "ui"],
    blockedBy: ["EPIC-C", "EPIC-D", "EPIC-E"],
    body: `Script and storyboard, image/video/audio creation, reference assets, variants and
metadata.`,
    criteria: [
      "Brief to editable script to storyboard shots to generated media to timeline, end to end",
      "Every result persists as a first-class library asset with full provenance",
      "Reference assets can drive image-to-video and video transformation where supported",
      "Generation panels disable anything the selected model cannot do",
    ],
  },
  {
    key: "EPIC-G",
    title: "EPIC G — Export and delivery",
    milestone: "Phase 3 — Polished MVP",
    labels: ["epic", "P0", "media", "ui"],
    blockedBy: ["EPIC-C", "EPIC-D"],
    body: `Export presets, captions, package project, error and recovery UI.`,
    criteria: [
      "H.264/AAC MP4 at 720p and 1080p with progress, cancel and logs",
      "Caption burn-in and SRT export",
      "`Package Project` produces a self-contained folder that opens on a clean machine",
      "Export failures surface an actionable error and a recovery path",
    ],
  },
  {
    key: "EPIC-H",
    title: "EPIC H — Quality",
    milestone: "Phase 3 — Polished MVP",
    labels: ["epic", "P0", "quality"],
    blockedBy: ["EPIC-F", "EPIC-G"],
    body: `Fixture projects, render golden tests, failure injection, migration and security
testing. This epic spans every phase; it is scheduled with Phase 3 because that is where the
shipping definition in PRD §17 lands.`,
    criteria: [
      "Fixture projects cover the happy path and the awkward cases (mixed rates, missing media)",
      "Golden-frame tests sample the title, crop, opacity, transition and caption cases",
      "Fault injection covers network loss, insufficient disk, killed render, billable timeout, missing media and corrupted cache",
      "Migration and security tests run in CI on every pull request",
    ],
  },
];

const CROSS_CUTTING = [
  {
    key: "GOLDEN-FRAMES",
    title: "Visual golden-frame regression tests",
    milestone: "Phase 3 — Polished MVP",
    labels: ["P0", "quality", "media"],
    blockedBy: ["FR-09"],
    body: `PRD §17 requires that title, crop, opacity, transitions and captions render the same in
preview and in the exported file. Byte equality is the wrong assertion because H.264 encoders
differ between builds, so compare sampled frames by mean absolute pixel difference against a
tolerance.`,
    criteria: [
      "Sampled frames are compared to committed reference frames with a documented tolerance",
      "Cases covered: title text, crop, opacity, crossfade and dip-to-black transitions, burn-in captions",
      "Failures produce a side-by-side diff artifact uploaded by CI",
      "The suite distinguishes a real regression from encoder noise and documents which",
    ],
  },
  {
    key: "FAULT-INJECTION",
    title: "Fault-injection test suite",
    milestone: "Phase 3 — Polished MVP",
    labels: ["P0", "quality", "core"],
    blockedBy: ["FR-10", "FR-01"],
    body: `PRD §17 enumerates the failures that must be survived. These are the cases that turn a
demo into a product.`,
    criteria: [
      "Network loss mid-poll resumes without duplicating a charge",
      "Insufficient disk fails the job cleanly and leaves the project intact",
      "A killed render leaves no temp file behind and no half-written output",
      "A provider billable timeout leaves the job in `unknown` and does not auto-resubmit",
      "Missing linked media surfaces a relink path; a corrupted cache is regenerated, not fatal",
    ],
  },
  {
    key: "CI-INSTALLERS",
    title: "CI build matrix and signed installers",
    milestone: "Phase 0 — Foundation",
    labels: ["P0", "host", "quality"],
    blockedBy: ["EPIC-A"],
    body: `PRD §15 gates Phase 0 on a working CI build, and PRD §19 asks whether Windows support is
simultaneous or later. This issue makes the portability claim testable rather than aspirational.`,
    criteria: [
      "CI builds, typechecks, lints and tests every workspace package plus the Rust host",
      "A macOS installer artifact is produced and uploaded per release build",
      "Windows and Linux compile (even if the release gate stays macOS-first)",
      "FFmpeg/ffprobe availability is verified on each platform, with a clear error when absent",
    ],
  },
  {
    key: "LICENSING-REVIEW",
    title: "Encoder availability and licensing review",
    milestone: "Phase 1 — Usable editor",
    labels: ["P0", "decision", "docs", "media"],
    blockedBy: ["FR-09"],
    body: `PRD §9 says to "Test encoder availability and Remotion licensing before distribution", and
PRD §19 decision 2 asks whether the product is commercial or internal-only. H.264 output
requires GPL-licensed x264, and Remotion carries its own commercial terms. This must be
resolved before anything is distributed, not after.`,
    criteria: [
      "The FFmpeg build used for distribution is pinned, and its configure flags are recorded",
      "The GPL obligation created by libx264 is documented, with the intended distribution model",
      "Remotion licensing is reviewed, and the decision to use or defer it is recorded",
      "The review outcome is captured in `LICENSE` and an ADR",
      "A per-platform encoder availability check runs at startup and degrades with a clear message",
    ],
  },
  {
    key: "ACCESSIBILITY",
    title: "Accessibility pass: keyboard, screen reader, contrast, reduced motion",
    milestone: "Phase 3 — Polished MVP",
    labels: ["P1", "ui", "quality"],
    blockedBy: ["FR-04", "FR-03"],
    body: `PRD §14 requires accessible keyboard navigation, basic screen-reader labelling, adequate
contrast and reduced-motion support.`,
    criteria: [
      "Every interactive control is reachable by keyboard with a visible focus ring",
      'The timeline ruler and scrubber expose `role="slider"` with `aria-valuenow`',
      "Export and generation progress announce via `aria-live`",
      "Text meets WCAG AA contrast against the dark theme",
      "`prefers-reduced-motion: reduce` disables non-essential animation",
    ],
  },
  {
    key: "PRIVACY-DISCLOSURE",
    title: "Remote-processing disclosure and consent for reference likenesses",
    milestone: "Phase 2 — AI creation",
    labels: ["P0", "security", "ui", "docs"],
    blockedBy: ["FR-08"],
    body: `PRD §12 requires that users be told exactly which files leave the device before an upload,
and PRD §13 requires rights/consent handling for reference likenesses, cloned voices and
uploaded copyrighted material.`,
    criteria: [
      "Before any upload, the UI names the exact files and the destination provider",
      "Provider retention and usage terms are linked at the point of upload",
      "Reference likeness and voice-cloning flows require an explicit rights confirmation",
      "Offline editing and export clearly work without transmitting any media",
      "Generation controls visibly indicate connectivity and credential state",
    ],
  },
  {
    key: "PORTABILITY",
    title: "Windows and Linux portability validation",
    milestone: "Phase 4 — Advanced",
    labels: ["P2", "decision", "host"],
    blockedBy: ["EPIC-A"],
    body: `PRD §19 decision 1 recommends macOS-first while preserving portability. This issue is how
that recommendation is kept honest: the architecture claims cross-platform support, so the
claim needs a test.`,
    criteria: [
      "No macOS-only API is used outside a documented, isolated platform shim",
      "Paths, keychain access and process spawning are abstracted per platform",
      "A Windows or Linux build boots and can create, save, reopen and export a project",
      "The outcome is recorded as a decision, with the remaining gaps listed",
    ],
  },
  {
    key: "PERF-RESILIENCE",
    title: "Performance and resilience targets",
    milestone: "Phase 3 — Polished MVP",
    labels: ["P1", "quality", "core", "media"],
    blockedBy: ["FR-04", "FR-09"],
    body: `PRD §14 sets the interactive and resilience targets: proxy-backed editing on a 16 GB
baseline laptop, bounded CPU/RAM for background derivatives, storage management, and offline
operation for existing assets.`,
    criteria: [
      "Drag and scrub stay under ~100 ms on a representative 1080p proxy project",
      "Background thumbnail/proxy/waveform jobs are bounded in CPU and RAM and can be paused",
      "Storage management reports cache size and available disk, and can purge caches safely",
      "Existing assets can be edited and exported with no network connection",
      "A baseline 16 GB laptop is the documented reference for these measurements",
    ],
  },
];

/**
 * Known gaps, found by building and cross-verifying the implementation.
 *
 * These are **not** derived from the PRD text the way the epics and FRs above are. They are
 * the places where the shipped code deliberately does not yet do what its own UI or schema
 * advertises, discovered while implementing and verified by grepping the code — every claim
 * below names the file that proves it. Each one is either disclosed in the UI (so no user is
 * misled) or returns an explicit error (so nothing fails silently); the issue exists so the
 * gap is closed rather than merely documented.
 *
 * `parent` links the gap to the requirement it belongs to, so it shows up in that
 * requirement's checklist — and a gap is deliberately **not** also marked blocked by its
 * own parent, because the parent closes when its children close. `blockedBy` is reserved
 * for genuine prerequisites between gaps.
 */
const KNOWN_GAPS = [
  {
    key: "GAP-GENERATION-CONTRACT",
    title: "Freeze the generation contract and implement provider submit and poll in the host",
    parent: "FR-10",
    milestone: "Phase 2 — AI creation",
    labels: ["P0", "providers", "host", "decision"],
    blockedBy: ["FR-08"],
    source: SECTION.jobs,
    body: `**This is the largest remaining gap: the desktop app cannot submit a generation.**

\`apps/desktop/src-tauri/src/providers.rs\` implements model listing, credential storage and
credential testing in full, but \`submit_job()\` and \`poll_job()\` both return
\`CommandError::unsupported\` with the same explanation:

> the per-mode generation request/response contract (image, video, audio, voice) is not frozen
> in \`protocol.ts\` or \`packages/core/src/jobs.ts\`, so submitting a paid request is
> deliberately not implemented rather than guessed at. Model listing, credential storage and
> credential testing are fully implemented.

That is the right call — guessing a paid request shape would be worse than refusing — but it
means \`IPC_COMMANDS\` has no \`generate\` command, so the Generate panel cannot reach a
provider. The capability-based adapter layer in \`packages/providers\` *is* complete and is
exercised end to end by \`pnpm e2e\` through the mock adapter; what is missing is the IPC
surface and the host-side job runner that joins the two.

## What closing this requires

1. Freeze \`GenerationRequest\` / \`SubmitResult\` / \`JobStatusResult\` as the wire contract
   (they already exist in \`packages/providers/src/requests.ts\`; the work is deciding what
   crosses IPC and mirroring it in \`protocol.ts\` and Rust \`serde\` structs).
2. Add the commands (\`generate_submit\`, \`generate_poll\`, or extend \`job_*\`) to
   \`IPC_COMMANDS\` **and** to the Rust allowlist — the two are pinned equal by
   \`security::tests::allowlist_matches_protocol_ts\`, so they cannot drift.
3. Implement the runner: capability validation, cost estimation, the budget gate, a durable
   \`generation_jobs\` row, submission under the idempotency key and submission lock, polling
   with backoff, then download → verify → atomic asset commit (PRD §9's data flow).
4. Keep the renderer free of keys: submission must happen host-side.

Note the policy boundary this must respect: a job whose submission outcome is unknown becomes
\`unknown\` and is **never** auto-resubmitted (PRD §12), because a resend could bill twice.`,
    criteria: [
      "The generation request/response contract is frozen in `protocol.ts` and mirrored in Rust",
      "A generation can be submitted, polled and cancelled from the UI against a real provider",
      "Capability validation and the budget gate run before submission, host-side",
      "A durable job row exists before submission, so a crash is reconcilable",
      "Uncertain submissions park in `unknown` and are never auto-resubmitted",
      "No API key crosses into the webview at any point",
      "`job_retry` and job polling/resumption stop returning `unsupported`",
    ],
  },
  {
    key: "GAP-RENDER-EFFECTS",
    title: "Render clip effects in the preview and the export",
    parent: "FR-12",
    milestone: "Phase 3 — Polished MVP",
    labels: ["P1", "media", "ui"],
    blockedBy: [],
    source: SECTION.fr,
    body: `\`packages/media/src/graph.ts\` never reads \`document.effects\` — a grep for \`effect\`
in that file returns nothing. An effect is therefore stored, persisted, round-tripped and
listed in the Inspector, but has no effect on the pixels. \`Add effect…\` is disabled and each
listed entry is badged \`inert\`, so no user is misled (PRD §8), but the feature is not real.

The schema already names the kinds to support: \`brightness\`, \`contrast\`, \`saturation\`,
\`blur\`, \`sharpen\`, \`grayscale\`, \`sepia\`, \`vignette\`, \`volume\`, \`eq\`, \`denoise\`.

Most map directly onto FFmpeg filters, which makes this the cheapest of the render gaps:
\`eq\` (brightness/contrast/saturation), \`unsharp\`, \`boxblur\` or \`gblur\`, \`hue=s=0\`
(grayscale), a \`colorchannelmixer\` sepia matrix, \`vignette\`, \`hqdn3d\` (denoise), and
\`volume\`/\`equalizer\` on the audio chain.

Because \`document.effects\` is keyed by \`clipId\` with a \`sortOrder\`, apply them in that
order, after the transform stages and before \`format=rgba\`, so effects see the cropped and
scaled image.\n\nThe preview must implement the same maths or FR-04 parity breaks — and
\`packages/media/src/golden.test.ts\` will now catch that by sampling pixels.`,
    criteria: [
      "Every effect kind in the schema is applied, in `sortOrder`, by both renderers",
      "`enabled: false` skips an effect",
      "The preview applies the same maths, verified by a golden-frame case",
      "Effect parameters become authorable in the Inspector once they render",
      "Stage order is pinned by tests on both sides, as for the transform stages",
    ],
  },
  {
    key: "GAP-RENDER-KEYFRAMES",
    title: "Render keyframes with property interpolation",
    parent: "FR-12",
    milestone: "Phase 4 — Advanced",
    labels: ["P2", "media", "ui", "core"],
    blockedBy: [],
    source: SECTION.fr,
    body: `\`document.keyframes\` is stored, persisted and round-tripped, and \`graph.ts\` never reads
it. Keyframes are the one render gap that is not a straight filter mapping: animating a
property over time means either time-varying FFmpeg expressions (\`overlay=x='…t…'\`,
\`colorchannelmixer\` cannot animate its alpha this way) or rendering in segments and
concatenating, which costs an extra encode generation.

The interpolation maths already exists conceptually in the schema — \`easing\` is one of
\`linear\`, \`ease-in\`, \`ease-out\`, \`ease-in-out\`, \`hold\`, \`bezier\` — so a shared
\`sampleProperty(keyframes, property, frame)\` function is the natural first step, used by both
the preview and the graph. The Inspector currently states that keyframes arrive with FR-12.

The PRD places keyframes in P1/FR-12 and in Phase 4 ("Keyframes, expanded transitions"), which
is why this is scoped as P2 rather than blocking the MVP.`,
    criteria: [
      "A shared interpolator resolves `(property, frame)` to a value for all six easing modes",
      "Animated `transform.x/y/scale/rotation/opacity` render and match the preview",
      "Interpolation is exact at keyframe frames and monotonic between them",
      "Golden-frame cases sample at and between keyframes",
      "Keyframe authoring is enabled in the Inspector once it renders",
    ],
  },
  {
    key: "GAP-RENDER-TRANSITIONS",
    title: "Render transitions, starting with dips to black and white",
    parent: "FR-12",
    milestone: "Phase 3 — Polished MVP",
    labels: ["P1", "media", "ui"],
    blockedBy: [],
    source: SECTION.fr,
    body: `\`graph.ts\` never reads \`transitionIn\`/\`transitionOut\`. All ten kinds the schema names
(\`crossfade\`, \`dip-to-black\`, \`dip-to-white\`, \`slide-left/right\`, \`wipe-left/right\`,
\`zoom-in/out\`) are inert. The picker labels each one "(not applied yet)" and disables it, and
\`RENDERED_TRANSITION_KINDS\` in \`Inspector.tsx\` is the single empty set that gates them.

**Suggested order, cheapest first:**

1. **Dips (\`dip-to-black\`, \`dip-to-white\`)** need no structural change. The composition base
   is already black, and FFmpeg's \`fade\` filter takes a colour, so a dip is a per-clip
   \`fade=t=in:color=black\` / \`fade=t=out:color=white\` — the same shape as the existing
   per-clip stage builders.
2. **\`crossfade\`** needs the compositor to *overlap* neighbouring clips. The current
   composition overlays every clip onto one base with
   \`overlay=…:enable='between(t,start,end)'\`, and each clip's window ends exactly where the
   next begins, so the outgoing clip is already hidden when the incoming one fades in. Options
   are \`tpad=stop_mode=clone\` on the outgoing clip plus a window extension (no source
   headroom needed), or restructuring to per-track \`xfade\` chains.
3. **Slide, wipe and zoom** need animated \`overlay\` offsets or crop windows.

Whatever lands must be mirrored in \`apps/desktop/src-tauri/src/render.rs\` and covered by a
golden-frame case; the PRD's §17 test plan names transitions explicitly.`,
    criteria: [
      "Dip transitions render in both renderers and in the preview",
      "Crossfade renders without needing source headroom beyond the clip",
      "A transition's `durationFrames` is honoured and clamped to the clip length",
      "`RENDERED_TRANSITION_KINDS` is populated so the picker enables exactly what renders",
      "Golden-frame cases sample inside each transition, not just before and after",
    ],
  },
  {
    key: "GAP-RENDER-TITLES",
    title: "Render titles and text overlays",
    parent: "FR-12",
    milestone: "Phase 4 — Advanced",
    labels: ["P2", "media", "ui"],
    blockedBy: [],
    source: SECTION.fr,
    body: `The schema has no text or title entity, and \`graph.ts\` contains no \`drawtext\`. PRD §9
suggests Remotion for "deterministic effects/text"; the export path deliberately uses FFmpeg
filter graphs instead (see ADR-0004), so titles would be \`drawtext\` with a bundled font, or a
rendered overlay image.

Two things make this more than a one-line addition: font availability and metrics differ across
machines, so \`drawtext\` output is not reproducible unless a font is shipped and pinned; and
the PRD's §17 golden tests name "title" as a case that must match preview to output, which
needs the preview to lay out text identically to FFmpeg.

Worth deciding explicitly: **titles as a clip property** (simplest, one text layer per clip)
versus **a distinct text/title entity on its own track** (more capable, more schema). The
current \`caption\` track kind is the nearest existing home.`,
    criteria: [
      "A title renders identically in the preview and the export, with a pinned font",
      "The text entity is stored in the project schema and survives a reopen",
      "A golden-frame case covers a title, as PRD §17 requires",
      "The decision between a clip property and a track entity is recorded in an ADR",
    ],
  },
  {
    key: "GAP-RENDER-CAPTIONS",
    title: "Render burn-in captions",
    parent: "FR-11",
    milestone: "Phase 3 — Polished MVP",
    labels: ["P1", "media", "ui"],
    blockedBy: [],
    source: SECTION.fr,
    body: `FR-11 requires "Speech-to-text, editable word/segment timing, SRT export, burn-in
captions". Transcription, editable timings and \`srtTimestamp\` exist in
\`apps/desktop/src/components/captionUtils.ts\`, but **burn-in is not rendered**: \`graph.ts\`
contains no reference to captions, subtitles, \`drawtext\` or burning, and the export preset's
\`burnInCaptions\` flag is only defined in \`packages/core/src/schema.ts\` — nothing in
\`packages/media\` or the Rust host reads it.

So the Export dialog's burn-in switch currently does nothing, which is the same
silently-ignored pattern as transitions and needs either implementation or the same disclosure
treatment.

Implementation is \`subtitles=…\` against a generated SRT (FFmpeg's \`subtitles\` filter, or
\`ass\` for styling), which reuses the SRT writer the panel already needs. That also keeps the
caption rendering path separate from the title path above.`,
    criteria: [
      "`burnInCaptions: true` burns captions into the exported file",
      "The SRT used for burning is the same one the export writes",
      "A golden-frame case asserts captions appear at the right frames",
      "The flag is either honoured or the control is disabled and disclosed, never silently ignored",
    ],
  },
  {
    key: "GAP-BLEND-MODES",
    title: "Add a blend-mode field to the schema and composite it",
    parent: "FR-12",
    milestone: "Phase 4 — Advanced",
    labels: ["P2", "core", "media", "ui"],
    blockedBy: [],
    source: SECTION.fr,
    body: `The Inspector lists blend mode as unsupported, and both halves of that are true: there is
no \`blend\` field in \`ClipProperties\` (\`grep -c blend packages/core/src/schema.ts\` returns 0)
and no compositing pass that would honour one. PRD §6 says "blend where supported", and PRD §4
places "GPU effects parity with desktop NLEs" out of scope, so this is a deliberate deferral
rather than an oversight.

Closing it means a schema field plus a new migration (never an edit to an applied one — see
\`runMigrations\`'s checksum guard), a per-clip blend stage, and preview parity. FFmpeg's
\`blend\` filter covers the common modes but needs two inputs, which does not fit the current
"overlay everything onto one base" composition; \`overlay\` alone offers no blend modes, so this
may force the per-track composition refactor that \`crossfade\` also wants.`,
    criteria: [
      "A migration adds the blend field without editing `0001_init.sql`",
      "At least `normal`, `multiply`, `screen` and `overlay` render",
      "Preview and export agree, verified by a golden-frame case",
      "The composition refactor this needs is either done or explicitly recorded as the blocker",
    ],
  },
  {
    key: "GAP-LIVE-PROVIDERS",
    title: "Verify the provider adapters against live APIs with real credentials",
    parent: "FR-08",
    milestone: "Phase 2 — AI creation",
    labels: ["P1", "providers", "quality"],
    blockedBy: ["GAP-GENERATION-CONTRACT"],
    source: SECTION.providers,
    body: `Every adapter test in this repository runs against a **mocked** \`fetch\`, deliberately:
the contract suite is table-driven across the mock, Vercel AI Gateway, ElevenLabs and Cloudflare
adapters and asserts normalization, 429 + \`Retry-After\` retry, retryable 500s, malformed
bodies, credential errors with a proven no-leak assertion, and rejection of expired output URLs.
That proves the *shape* of the integration, not that it matches the provider's live API today.

Two things are therefore unverified in the session that produced this code:

1. That the request paths, payload field names and auth headers match each provider's current
   published API. The adapter authors made judgement calls — for example the Vercel gateway
   paths are configurable defaults because the gateway's exact REST paths evolve, and
   \`cancel()\` on ElevenLabs and Cloudflare is a documented no-op because both APIs are
   synchronous.
2. That a real generation round trip works: submit, poll, download, verify, commit as an asset,
   with a real cost recorded.

PRD §20 explicitly warns that "specific provider models, costs, capabilities, licensing and
availability must be revalidated during development". This issue is that revalidation.`,
    criteria: [
      "Model listing works against each live provider and normalizes into `ModelDescriptor`",
      "One real generation per modality completes and commits a valid asset",
      "Provider-reported cost is recorded and matches the estimate within a documented tolerance",
      "Any path, field name or capability that differs from the adapters is corrected, with the fixture updated",
      "Only test accounts and small/cheap requests are used, and no key is committed",
    ],
  },
  {
    key: "GAP-APP-ICON",
    title: "Replace the generated placeholder app icon before release packaging",
    parent: "CI-INSTALLERS",
    milestone: "Phase 3 — Polished MVP",
    labels: ["P1", "host", "docs"],
    blockedBy: ["CI-INSTALLERS"],
    source: SECTION.milestones,
    body: `\`apps/desktop/src-tauri/icons/icon.png\` is generated programmatically by \`build.rs\`
(a 512x512 RGBA PNG with CRC-validated chunks) purely because \`tauri::generate_context!\`
requires the file to exist. It is placeholder art, not a designed icon, and \`bundle.icon\` in
\`tauri.conf.json\` is consequently \`[]\`.

A release build needs a real iconset: a designed source image, then
\`tauri icon <source.png>\` to generate the .icns/.ico and the multi-size PNG set, and
\`bundle.icon\` populated from it. This blocks signed macOS packaging in practice, so it belongs
with the installer work rather than on its own.`,
    criteria: [
      "A designed source icon exists and is committed",
      "`tauri icon` generates the platform iconsets and `bundle.icon` lists them",
      "The generated placeholder is deleted so it cannot silently ship",
      "A packaged build shows the real icon in Finder and the dock",
    ],
  },
  {
    key: "GAP-SECURITY-REVIEW",
    title: "Commission an independent security review",
    parent: "EPIC-H",
    milestone: "Phase 4 — Advanced",
    labels: ["P2", "security", "quality"],
    blockedBy: [],
    source: SECTION.security,
    body: `\`docs/SECURITY.md\` states plainly that **no third-party security audit has been
performed**. The guarantees in it are enforced and tested — keys confined to the OS keychain
with a schema that cannot hold a secret, an allowlisted IPC surface pinned equal to
\`protocol.ts\` by a test, workspace-scoped path validation including symlink escape, argument-array
process spawning proven against \`; rm -rf / && $(whoami)\`, and redaction that is asserted by the
*absence* of a secret rather than the presence of a placeholder — but they are the author's own
claims about the author's own code.

Because this product handles the user's media and their provider credentials, and because a
defect would be a credential or media exposure rather than a cosmetic bug, an outside review is
worth scheduling before any public release, not after.

The documented limitations in \`docs/SECURITY.md\` are the natural starting brief: provider-side
retention is out of our control, protection is only as strong as the OS account, media is not
re-encoded for sanitisation so an FFmpeg codec vulnerability is a vulnerability here, and the
clip-effect/keyframe gap is a fidelity issue rather than a security one.`,
    criteria: [
      "An independent review covers the IPC allowlist, path scoping, credential handling, redaction and process spawning",
      "Findings are triaged into issues with severities, and fixes are closed with tests",
      "The review scope and date are recorded in `docs/SECURITY.md`",
      "The pinned FFmpeg build and its provenance are part of the review",
    ],
  },
  {
    key: "GAP-GOLDEN-BASELINES",
    title: "Decide how golden-frame reference images are stored",
    parent: "GOLDEN-FRAMES",
    milestone: "Phase 3 — Polished MVP",
    labels: ["P1", "decision", "quality"],
    blockedBy: [],
    source: SECTION.testPlan,
    body: `\`packages/media/src/golden.test.ts\` deliberately commits **no reference images**. Each
case asserts a property of known geometry — "the centre of a half-scaled red clip is red and its
corner is black" — with an explicit tolerance, because a byte-exact golden file fails on every
FFmpeg or x264 upgrade for reasons unrelated to this codebase.

That is defensible and it found a real defect on its first run (a preview/export parity break on
\`transform.scale\`), but it has limits: it can prove a colour is present, not that a composite
frame looks *right*, and it cannot validate a gradient, a font's rendering, or a complex
transition. PRD §17 asks for "visual golden tests" without prescribing the mechanism.

This issue is the explicit decision so it does not get made by accident:

**Option A — geometry assertions only (current).** No binaries in git, immune to encoder drift,
weaker coverage of composites.
**Option B — committed reference PNGs plus a perceptual diff.** Strong coverage, needs a
documented tolerance, a regeneration command, and a policy for accepting an intentional change;
adds binary files to the repository.
**Option C — hybrid.** Geometry assertions as the always-on gate in CI, plus a smaller set of
reference images for a few composite cases that only runs on demand or on a nightly schedule.

A decision is needed before captions and transitions land, because those are the cases where
Option A is weakest.`,
    criteria: [
      "One of the three options is chosen and recorded, in an ADR if it is B or C",
      "If reference images are stored, there is a documented regeneration command and tolerance",
      "The decision explains what happens when an intentional visual change is made",
      "Whichever option is chosen runs in CI with a stated runtime budget",
    ],
  },
];

const ALL_ISSUES = [...EPICS, ...FUNCTIONAL_REQUIREMENTS, ...CROSS_CUTTING, ...KNOWN_GAPS];

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

function gh(args, options = {}) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Is this failure GitHub telling us the relationship already exists?
 *
 * `execFileSync` puts the child's stdout/stderr on the error object, **not** in
 * `error.message` — so matching on the message alone silently fails to detect a duplicate,
 * which is what made a second run of this script report every dependency as an error.
 */
function isAlreadyLinked(error) {
  const text = `${error?.message ?? ""}\n${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
  return text.includes("422") || /already been taken|already exists/i.test(text);
}

function ghJson(args) {
  const output = execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return output.length === 0 ? null : JSON.parse(output);
}

function parseArgs(argv) {
  const result = { repo: null, dryRun: false, skipHierarchy: false, includeCrossCutting: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") result.repo = argv[++index];
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--skip-hierarchy") result.skipHierarchy = true;
    else if (arg === "--only-epics") result.includeCrossCutting = false;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

const USAGE = `Create the PRD-derived GitHub backlog.

  node tools/github/create-backlog.mjs [--repo owner/name] [options]

Options:
  --dry-run          Print the plan without touching GitHub
  --skip-hierarchy   Create issues but skip sub-issue and blocked-by links
  --only-epics       Create only the eight PRD §16 epics
  --help             Show this message
`;

function prdLink(section, label) {
  return `[${label}](${section})`;
}

function buildBody(issue) {
  const lines = [];
  // Epics and FRs come from PRD §7/§16; gap issues cite the section they actually belong to
  // (§12 for the job contract, §13 for the review, §17 for the test-plan decision, ...).
  const source = issue.source ?? SECTION.fr;
  lines.push(`> **Source of truth:** ${prdLink(source, "PRD")} · \`${PRD}\``);
  lines.push("");
  lines.push(issue.body);
  lines.push("");
  lines.push("## Acceptance criteria");
  lines.push("");
  for (const criterion of issue.criteria) lines.push(`- [ ] ${criterion}`);
  lines.push("");
  if (issue.blockedBy && issue.blockedBy.length > 0) {
    lines.push("## Dependencies");
    lines.push("");
    lines.push(
      "Blocked by the issues listed in the GitHub sidebar (tracked as real issue dependencies). " +
        "This mirrors the delivery order the PRD implies in " +
        prdLink(SECTION.milestones, "§15") +
        ".",
    );
    lines.push("");
  }
  lines.push("## References");
  lines.push("");
  lines.push(`- ${prdLink(SECTION.epics, "PRD §16 — Implementation backlog (epics)")}`);
  lines.push(`- ${prdLink(SECTION.testPlan, "PRD §17 — Test plan and definition of done")}`);
  lines.push(`- ${prdLink(SECTION.security, "PRD §13 — Security, privacy and policy")}`);
  lines.push(`- ${prdLink(SECTION.milestones, "PRD §15 — Delivery milestones")}`);
  lines.push("");
  return lines.join("\n");
}

function sectionFor(issue) {
  if (issue.key.startsWith("EPIC")) return SECTION.epics;
  if (/^FR-\d+$/.test(issue.key)) return SECTION.fr;
  return SECTION.testPlan;
}

/**
 * Derive `owner/name` from the origin remote so the script needs no arguments.
 * `remote get-url` is a git subcommand, not a gh one — hence the separate runner.
 */
function repoFromOrigin() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const match = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.repo) args.repo = repoFromOrigin();
  if (!args.repo) {
    process.stderr.write("Could not determine the repository. Pass --repo owner/name.\n\n");
    process.stdout.write(USAGE);
    return 2;
  }

  const [owner, name] = args.repo.split("/");
  if (!owner || !name) throw new Error(`--repo must be owner/name, received "${args.repo}"`);

  const issues = args.includeCrossCutting ? ALL_ISSUES : EPICS;

  if (args.dryRun) {
    process.stdout.write(`DRY RUN — ${args.repo}\n\n`);
    process.stdout.write(`Milestones (${MILESTONES.length})\n`);
    for (const milestone of MILESTONES) process.stdout.write(`  · ${milestone.title}\n`);
    process.stdout.write(`\nLabels (${LABELS.length})\n`);
    process.stdout.write(`  ${LABELS.map((label) => label.name).join(", ")}\n`);
    process.stdout.write(`\nIssues (${issues.length})\n`);
    for (const issue of issues) {
      const deps = (issue.blockedBy ?? []).join(", ") || "—";
      process.stdout.write(
        `  ${issue.key.padEnd(16)} ${issue.milestone.padEnd(28)} blocked by: ${deps}\n`,
      );
    }
    const dependencyCount = issues.reduce((sum, issue) => sum + (issue.blockedBy?.length ?? 0), 0);
    process.stdout.write(`\nTotal dependency edges: ${dependencyCount}\n`);
    return 0;
  }

  // 1. Labels -----------------------------------------------------------------
  process.stdout.write(`→ labels in ${args.repo}\n`);
  for (const label of LABELS) {
    try {
      gh([
        "label",
        "create",
        label.name,
        "--color",
        label.color,
        "--description",
        label.description,
        "--force",
        "-R",
        args.repo,
      ]);
    } catch (error) {
      process.stdout.write(`  ! label ${label.name}: ${String(error.message).split("\n")[0]}\n`);
    }
  }

  // 2. Milestones -------------------------------------------------------------
  process.stdout.write(`→ milestones\n`);
  const existingMilestones = new Set(
    (ghJson(["api", `/repos/${args.repo}/milestones?state=all&per_page=100`]) ?? []).map(
      (entry) => entry.title,
    ),
  );
  for (const milestone of MILESTONES) {
    if (existingMilestones.has(milestone.title)) continue;
    gh([
      "api",
      "--method",
      "POST",
      `/repos/${args.repo}/milestones`,
      "-f",
      `title=${milestone.title}`,
      "-f",
      `description=${milestone.description}`,
    ]);
  }

  // 3. Issues -----------------------------------------------------------------
  process.stdout.write(`→ issues\n`);
  const existing =
    ghJson([
      "issue",
      "list",
      "--state",
      "all",
      "--limit",
      "500",
      "--json",
      "number,title",
      "-R",
      args.repo,
    ]) ?? [];
  const numberByTitle = new Map(existing.map((entry) => [entry.title, entry.number]));

  const created = new Map(); // key -> { number, id }
  for (const issue of issues) {
    const body = buildBody(issue);
    let number = numberByTitle.get(issue.title);
    if (number === undefined) {
      const url = gh([
        "issue",
        "create",
        "-R",
        args.repo,
        "--title",
        issue.title,
        "--body",
        body,
        "--milestone",
        issue.milestone,
        ...issue.labels.flatMap((label) => ["--label", label]),
      ]);
      number = Number.parseInt(url.split("/").pop(), 10);
      process.stdout.write(`  + #${number} ${issue.title}\n`);
    } else {
      process.stdout.write(`  = #${number} ${issue.title} (exists)\n`);
    }
    const details = ghJson([
      "api",
      `/repos/${args.repo}/issues/${number}`,
      "--jq",
      "{id: .id, number: .number}",
    ]);
    created.set(issue.key, { number, id: details.id });
    void sectionFor(issue);
  }

  if (args.skipHierarchy) {
    process.stdout.write("→ skipping sub-issue and dependency links (--skip-hierarchy)\n");
    return 0;
  }

  // 4. Sub-issues: functional requirements and cross-cutting work under an epic ---
  process.stdout.write(`→ sub-issue hierarchy\n`);
  for (const issue of issues) {
    // FR issues attach to an epic via `epic`; gap issues attach via `parent`. Everything else
    // (epics, cross-cutting issues) is already at the top level.
    if (!issue.key.startsWith("FR-") && !issue.parent) continue;
    // An explicit `parent` key wins, which is how the gap issues attach to the requirement
    // they belong to (or to a cross-cutting issue such as the golden-frame suite). Otherwise
    // `issue.epic` is a bare letter, or two letters for a requirement that spans epics
    // (FR-02 is "B/D" — persistence *and* media). A GitHub sub-issue has exactly one parent,
    // so the first letter is the primary epic and the blocked-by edges carry the secondary
    // relationship. The issue map is keyed by the full "EPIC-A"/"FR-12" identifier, and
    // getting that wrong silently skipped every link.
    let parent;
    if (issue.parent) {
      parent = created.get(issue.parent);
      if (!parent) {
        process.stdout.write(`  ! ${issue.key}: unknown parent ${issue.parent}\n`);
        continue;
      }
    } else {
      const epicLetter = (issue.epic ?? "").split("/")[0];
      if (epicLetter.length === 0) continue;
      parent = created.get(`EPIC-${epicLetter}`);
    }
    const child = created.get(issue.key);
    if (!parent || !child) continue;
    try {
      gh([
        "api",
        "--method",
        "POST",
        `/repos/${args.repo}/issues/${parent.number}/sub_issues`,
        "-F",
        `sub_issue_id=${child.id}`,
      ]);
      process.stdout.write(`  #${parent.number} ⊃ #${child.number}\n`);
    } catch (error) {
      if (isAlreadyLinked(error)) {
        process.stdout.write(`  = #${parent.number} ⊃ #${child.number} (exists)\n`);
        continue;
      }
      process.stdout.write(`  ! ${issue.key}: ${String(error.message).split("\n")[0]}\n`);
    }
  }

  // 5. Dependencies: the real blocked-by graph --------------------------------
  process.stdout.write(`→ blocked-by dependencies\n`);
  let edges = 0;
  for (const issue of issues) {
    const blocked = created.get(issue.key);
    if (!blocked) continue;
    for (const dependencyKey of issue.blockedBy ?? []) {
      const dependency = created.get(dependencyKey);
      if (!dependency) {
        process.stdout.write(`  ! ${issue.key} references unknown dependency ${dependencyKey}\n`);
        continue;
      }
      try {
        gh([
          "api",
          "--method",
          "POST",
          `/repos/${args.repo}/issues/${blocked.number}/dependencies/blocked_by`,
          "-F",
          `issue_id=${dependency.id}`,
        ]);
        process.stdout.write(`  #${blocked.number} blocked by #${dependency.number}\n`);
        edges += 1;
      } catch (error) {
        // A duplicate dependency returns 422 with "Target issue has already been taken";
        // that is the expected outcome of an idempotent re-run, not a failure.
        if (isAlreadyLinked(error)) {
          edges += 1;
          continue;
        }
        process.stdout.write(
          `  ! ${issue.key} <- ${dependencyKey}: ${String(error.message).split("\n")[0]}\n`,
        );
      }
    }
  }

  process.stdout.write(
    `\nDone: ${issues.length} issues, ${edges} dependency edges in ${args.repo}\n`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`\nFailed: ${error.message}\n`);
  process.exitCode = 1;
}
