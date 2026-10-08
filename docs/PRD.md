# Local-First AI Creative Studio

PRODUCT REQUIREMENTS DOCUMENT  |  Version 1.0  |  07 October 2026

Desktop video, image, audio and voice generation with a professional non-destructive editor and entirely local project ownership.

## 1. Executive summary

Build a macOS-first desktop creative studio (Windows/Linux-compatible architecture) that lets a creator move from a prompt or imported footage to an editable, exported video. All projects, media, timeline states, caches, exports, and credentials are managed locally. AI inference can use connected cloud gateways or direct provider APIs; local inference is a later optional extension. No cloud account, hosted database, or mandatory backend is required for core editing.

Core principle: AI creates assets and proposes edits; the local timeline is the source of truth. The user can always edit, replace, trim, regenerate, export and reopen their work without depending on any one AI provider.

## 2. Goals and success metrics

- P0: Create/open/save a portable project; import images, video and audio; edit a multi-track timeline; render MP4 locally.
- P0: Generate images, video, narration, speech and SFX through swappable providers; every result persists as a first-class library asset.
- P0: Enable an end-to-end workflow: idea → script/storyboard → shot generation → timeline → preview → export.
- P1: Automatic captions, audio waveform editing, transition presets, keyframes, reusable scenes, asset variants and prompt history.
- P2: Optional local inference, intelligent multi-shot assembly, collaborative/cloud sync, advanced grading and motion tracking.

| Metric | Release target / test |
| --- | --- |
| Local project reliability | 100 consecutive create/save/reopen tests without broken references |
| Export correctness | 10-minute mixed-media test exports with synchronized audio and no missing frames |
| Editing response | Drag/scrub interaction typically <100 ms on a representative 1080p proxy project |
| Generation traceability | 100% of AI assets retain model, prompt, parameters, job state and cost where available |
| Recoverability | Crash-recovery snapshot and undo/redo validated in automated tests |

## 3. Target users and jobs to be done

| Persona | Primary job |
| --- | --- |
| Solo creator | Create shorts, reels, promos and explainers with generated and imported assets. |
| Marketing operator | Produce repeatable branded video variants with templates and consistent voice. |
| Technical creator | Tune provider/model parameters, use local assets, inspect jobs and avoid lock-in. |

## 4. Scope and boundaries

### In scope — MVP

- macOS desktop application, local storage, API key settings, project manager and onboarding.
- Non-linear multi-track editing: drag/drop, trim, split, move, reorder, crop, scale, rotate, opacity, volume, speed controls where feasible.
- Canvas preview with safe areas and 16:9, 9:16, 1:1 aspect presets; 24/25/30/60 fps project presets.
- Media import, metadata inspection, proxies, thumbnails, waveform extraction, trash/relink, duplicate detection.
- AI prompt panels for script/storyboard, text-to-image, image-to-video, text-to-video, speech/narration, music/SFX and transcription where supported.
- Local H.264 MP4 output, export progress, cancellation, job queue and error reporting.

### Explicitly out of scope — MVP

- Realtime multi-user collaboration, mobile editor, commercial cloud sync, integrated payments and a public model marketplace.
- Professional-grade color grading, GPU effects parity with desktop NLEs, face/voice cloning without strong consent protections.
- Offline availability of cloud AI models; offline means editing/exporting existing assets without Internet.

## 5. Primary user journeys

1. Blank project: select orientation, dimensions and fps → import media → create tracks → edit → save → export.
1. AI-first: enter a creative brief → generate editable script → storyboard shots → generate media per shot → place chosen variants on timeline → add narration/music/captions → export.
1. Reference-based: import an image/video → select a clip or shot → use image-to-video / video transformation with compatible provider → preview variation → replace or append, retaining original.
1. Voice-over: write script → select provider/model/voice/language → synthesize → edit timing/captions → regenerate only selected sentence → preserve all revisions.
1. Recovery: close/reopen project or recover after crash; missing assets identified and relinked; pending cloud jobs can resume polling.

## 6. Experience and UI specification

Layout: top global toolbar (project, undo/redo, aspect, playback and export); left rail (Media, Generate, Audio, Captions, Templates, Projects); middle canvas preview; right contextual inspector; full-width resizable bottom timeline. Panels can be resized/hidden and workspace layouts saved.

- Media panel: asset grid/list, filters by type/provenance, folder tags, original/AI variants and drag-to-timeline.
- Generation panel: modality selector, prompt, negative prompt if supported, references, compatible models, aspect, duration, seed, quality, estimated price, Generate action, job history.
- Timeline: track headers, lock/mute/solo/visibility, clips with thumbnails/waveforms, snapping, zoom, playhead, ripple/overwrite edit modes, split and trim handles.
- Inspector: position/scale/crop/opacity, blend where supported, audio gain/fades, in/out, speed, transitions, effects and AI provenance.
- Storyboard view: ordered shots with text, duration, prompt and optional reference image; convert to timeline without flattening.
- Keyboard: space play/pause; J/K/L transport; S split; Cmd/Ctrl+Z undo; +/- timeline zoom; delete and multi-select. Configurable shortcuts later.

## 7. Functional requirements and acceptance criteria

| ID / Priority | Requirement | Acceptance criteria |
| --- | --- | --- |
| FR-01 P0 | Projects and snapshots | Create/open/rename/duplicate/save; save is atomic; undo/redo survives during session; recover last autosave. |
| FR-02 P0 | Local media library | Import common MP4/MOV/WEBM, PNG/JPEG/WEBP, WAV/MP3; probe metadata; detect missing paths. |
| FR-03 P0 | Timeline editing | At least 3 video and 4 audio tracks; split, trim, move, overlap, snap and reorder without modifying source files. |
| FR-04 P0 | Preview and playback | Composition matches render for positioning and basic transforms; proxy use handles heavier assets. |
| FR-05 P0 | Video generation | Run text-to-video and image-to-video with selected supported models; async status and downloadable asset persisted. |
| FR-06 P0 | Image generation/editing | Generate new images, create variants and edit using reference image when supported. |
| FR-07 P0 | Audio generation | Create spoken narration and SFX; music generation when provider supports it; waveform and timing controls. |
| FR-08 P0 | Provider settings | Configure gateway/direct credentials in OS credential vault; validate connection; show available models and capability settings. |
| FR-09 P0 | Export | Render timeline to H.264/AAC MP4 and choose 720p/1080p with progress, cancel and logs. |
| FR-10 P0 | Jobs and budgets | Queue, cancel where supported, retry transient failures, poll remote jobs, avoid duplicate charges. |
| FR-11 P1 | Captions | Speech-to-text, editable word/segment timing, SRT export, burn-in captions. |
| FR-12 P1 | Advanced editor | Keyframes, transitions, clip effects, fades, clip grouping, nesting and reusable templates. |
| FR-13 P1 | AI assistant | Suggest storyboard, captions, cuts and timing; preview diff and require explicit apply. |
| FR-14 P2 | Local inference | Pluggable on-device models for selected operations without changing project schema. |

## 8. Provider strategy and compatibility

Implement capability-based adapters, not one hard-coded SDK abstraction. Gateway access is preferred when it exposes the required controls; direct REST adapters remain available for provider-specific APIs or unsupported capabilities. A live model catalog drives the UI and is cached locally with a refresh timestamp.

| Integration | Candidate uses | Integration notes |
| --- | --- | --- |
| Vercel AI Gateway | Text, images, video, speech, transcription | Primary aggregator; check current supported model/capability per modality. |
| ElevenLabs direct | TTS, sound effects, music, transcription | Voice selection, audio-specific parameters, licensing and cloning permissions. |
| MiniMax direct / via supported gateway | Video, speech, music | Enable only API-verified endpoints and supported account regions. |
| Cloudflare AI / Workers AI | Image, transcription, TTS, selected video | Distinguish Workers AI-hosted from third-party catalog offerings. |
| Others: Kling, Veo, Wan, Runway, Luma, OpenAI, etc. | Video/image generation | Optional adapters; availability, terms and model naming change. |

Adapter contract: listModels(); describeCapabilities(model); estimateCost(request); validate(request); submit(request); getJob(jobId); cancel(jobId?); fetchOutputs(job); normalizeError(error). Support synchronous and asynchronous providers, output URLs with expiry, input uploads and provider rate limits.

Capability schema fields: modality, modes (text-to-video, image-to-video, etc.), input mime types, accepted aspect ratios/resolutions, duration min/max, seed, negative prompt, reference frame requirements, audio generation, voice/language options, max concurrency, pricing units, quota and safety metadata. Unknown features must be hidden/disabled rather than silently ignored.

## 9. System architecture

UI: Vite + React + TypeScript, TanStack Query for async state, Zustand for editor ephemeral state, React DnD/pointer-driven timeline layer. Desktop: Tauri 2 with a limited command IPC interface and native secure credential storage. Local services: Rust commands or packaged Node sidecar for AI SDK compatibility, background jobs, file I/O, media probing and render orchestration. Avoid exposing raw API keys to renderer/webview.

Data: SQLite with transactional migrations for project metadata, clips, tracks, assets, jobs and provider configuration metadata. User-selectable workspace folder contains project manifest, imported/generated media and derived caches. Store imported media copied into project assets by default; allow linked originals as an explicit advanced option.

Rendering: canonical frame-based composition model. Use Remotion React compositions for deterministic effects/text and export orchestration; FFmpeg/ffprobe for probing, proxy generation, transcoding, muxing, thumbnails and waveforms. Test encoder availability and Remotion licensing before distribution. Avoid relying exclusively on browser video elements for export parity.

Suggested data flow: Prompt → Capability validation → Cost confirmation → Local job record → Gateway/Provider → Poll/webhook-equivalent local scheduler → Download to temporary file → Verify checksum/media → Atomic asset commit → Timeline insertion on user action → Render/export.

## 10. Data model

| Entity | Key fields |
| --- | --- |
| Project | id, schemaVersion, title, fps numerator/denominator, width, height, color profile, createdAt, updatedAt |
| Asset | id, mediaType, uri, relativePath, sha256, durationFrames, dimensions, codec, provenance, parentAssetId |
| Sequence | id, projectId, name, settings, durationFrames |
| Track | id, sequenceId, type, order, muted, locked, hidden |
| Clip | id, trackId, assetId, startFrame, sourceInFrame, durationFrames, propertiesJson, version |
| Effect/Keyframe | id, clipId, type, params, property, frame, easing |
| GenerationJob | id, provider, model, mode, normalizedRequest, providerJobId, status, retryCount, costEstimate, actualCost |
| PromptRevision | id, jobId, prompt, negativePrompt, references, seed, parameters, createdAt |
| ExportJob | id, sequenceId, preset, outputPath, status, progress, errors |

Use integer frames or rational time for timeline coordinates, never floating-point seconds as canonical clip boundaries. Use immutable media assets and versioned project migrations. Maintain the provenance graph from generated variants back to original references and prompts.

## 11. Local project filesystem

Workspace/ProjectName/project.json; project.db (or app-wide SQLite with portable export); assets/originals; assets/generated/{image,video,audio}; cache/{proxies,thumbnails,waveforms}; exports; backups. Manifest uses project-relative references; backups exclude rebuildable caches by default. A “Package Project” export copies all dependencies and validates relinking.

## 12. Background processing and rendering

- Persistent local job queue with states queued, validating, submitting, running, downloading, completed, failed, canceled and unknown.
- Cloud tasks support asynchronous polling with exponential backoff and jitter, provider Retry-After, bounded retries and reconciliation on restart.
- Use idempotency keys where supported and a local submission lock to reduce duplicate paid requests; uncertain submissions must not auto-resubmit.
- Input references may require upload to a provider; alert users exactly which files leave the device and expose privacy terms.
- Derived thumbnails/proxies/waveforms generated in background with bounded CPU/RAM; render queue uses temp output then atomic rename.
- Preview quality adaptive; export always renders at project settings from originals, not proxies.

## 13. Security, privacy and policy requirements

- API keys stored in OS keychain/secure credential store; no plaintext .env inside packaged project and no keys in logs or exported projects.
- Native IPC is allowlisted, scopes file permissions to approved workspace paths and validates all command arguments.
- No publicly reachable local HTTP server; if loopback service necessary, bind 127.0.0.1 with per-session token and strict CORS.
- Disclose remote processing and possible third-party retention; offline edit/export operates without transmitting media.
- Restrict executable/media handling: sanitization, MIME/codec probing, no shell injection, safe FFmpeg process invocation, disk limits.
- Require rights/consent for reference likenesses, cloned voices and uploaded copyrighted material; respect provider usage and commercial licensing terms.
- Cost caps per job, daily budget ceiling, cost estimate/unknown pricing warning, and explicit approval above threshold.

## 14. Performance and resilience

- Target smooth editing with proxy files for 1080p and 4K sources; test on baseline 16 GB RAM laptop.
- Autosave debounced after changes plus periodic crash snapshots; never overwrite healthy project atomically with a partial write.
- Local assets and export function offline. Generation buttons visibly indicate connectivity and credentials.
- Storage management UI: cache size, available disk, cleanup and project packaging.
- Accessible keyboard navigation, basic screen-reader labeling, contrast and reduced-motion support.

## 15. Delivery milestones and dependencies

| Phase | Deliverable | Release gate |
| --- | --- | --- |
| Phase 0 — foundation | Tauri shell, workspace, SQLite migrations, project serialization, media probe, provider contract | Create-save-reopen and media ingestion reliable. |
| Phase 1 — usable editor | Timeline, preview, inspector, import, undo/redo, proxy jobs, MP4 render | User edits an imported 60-sec project and exports correctly. |
| Phase 2 — AI creation | Vercel Gateway, ElevenLabs, first video adapter, generation queue, model capabilities | All core modalities generate and persist to media library. |
| Phase 3 — polished MVP | Storyboards, voiceover, caption workflow, cost budgets, templates, packaging | Brief-to-export demo and recovery tests pass. |
| Phase 4 — advanced | Keyframes, expanded transitions, smarter AI editing, more providers, local inference exploration | Post-MVP based on user feedback. |

## 16. Implementation backlog (epics)

- EPIC A — desktop infrastructure: bootstrapping, native permissions, CI installers, crash reporting opt-in.
- EPIC B — persistence: project schema, SQLite migrations, asset manager, relative URIs, autosave, history.
- EPIC C — timeline: timebase utility, clips/tracks, transforms, snapping, interactions, keyboard and selection.
- EPIC D — render and media: ffprobe, thumbnails, waveform, FFmpeg transcodes, preview/export parity, progress/cancel.
- EPIC E — providers: registry, capability discovery, secure credentials, adapters, estimation and remote jobs.
- EPIC F — creative AI: script/storyboard, image/video/audio creation, reference assets, variants and metadata.
- EPIC G — export/delivery: presets, captions, package project, error/recovery UI.
- EPIC H — quality: fixture projects, render golden tests, failure injection, migration and security testing.

## 17. Test plan and definition of done

- Unit: frame/time math; serialization; effect calculations; capability validation; cost estimation; job transitions.
- Integration: provider adapters via mocked HTTP; rate limiting; timeouts; malformed results; expiring media URLs; application restart recovery.
- End-to-end: mixed audio/video/image project, timeline editing, autosave, reopen, 1080p export, A/V sync validation.
- Visual golden tests: title, crop, opacity, transitions and captions match preview to output at sampled frames.
- Fault injection: network loss, insufficient disk, killed render, provider billable timeout, missing linked media, corrupted cache.
- Shipping definition: P0 acceptance criteria pass on reference macOS hardware, no project data-loss defects, credential leakage or silent billing retries.

## 18. Risks and trade-offs

| Risk | Mitigation |
| --- | --- |
| Browser preview differs from exported video | Shared composition spec, golden frames, minimal effect subset at launch. |
| Provider APIs/pricing change | Capability registry, adapters, contract tests, in-app last-refreshed price and fallback. |
| Long-running video job instability | Durable job records, polling, safe download, manual reconciliation. |
| Desktop render packaging/codec complexity | Pinned FFmpeg binary and tests by OS/architecture; licensing review. |
| Scope explosion in video editor | Ship reliable trimming, audio mixing and basic transforms before advanced NLE features. |
| Cloud AI consumes private assets | Explicit transfer disclosure and clear local/cloud processing indicators. |

## 19. Open decisions

1. macOS-first packaging, or simultaneous Windows support? Default recommendation: macOS-first while preserving portability.
1. Commercial vs internal-only use? Remotion and bundled codec distribution licenses require review.
1. Should a project bundle copy imports by default? Recommendation: yes, with optional linked media.
1. Should external AI cost be user-owned BYOK only? Recommendation: BYOK for MVP with no application billing.
1. Should assistant apply timeline changes automatically? Recommendation: proposals + diff + explicit user confirmation.
1. Which 2–3 video models should be initial launch targets? Select by supported APIs, quality, cost and regional access, not marketing claims.

## 20. Reference documentation (verified October 2026)

Vercel AI Gateway modalities: https://vercel.com/ai-gateway

Vercel video quickstart: https://vercel.com/docs/ai-gateway/getting-started/video

Vercel provider listing: https://vercel.com/ai-gateway/models/providers

ElevenLabs overview: https://elevenlabs.io/api

ElevenLabs TTS: https://elevenlabs.io/docs/overview/capabilities/text-to-speech

ElevenLabs SFX: https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert

Cloudflare model catalog: https://developers.cloudflare.com/ai/models/

Cloudflare Workers AI: https://developers.cloudflare.com/workers-ai/models/

Tauri sidecars: https://v2.tauri.app/reference/javascript/shell/

Remotion documentation: https://www.remotion.dev/docs/

Note: product scope and target metrics are proposed requirements, not claims that these integrations or performance targets have already been implemented. Specific provider models, costs, capabilities, licensing and availability must be revalidated during development.
