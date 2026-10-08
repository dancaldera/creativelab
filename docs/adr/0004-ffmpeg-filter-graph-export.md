# ADR 0004 — FFmpeg filter graphs for export, not browser playback or Remotion

- **Status:** accepted
- **Date:** 2026-10-07
- **Requirements:** PRD §9 (Rendering), §4 (out of scope), FR-04 (preview matches render),
  FR-09 (H.264/AAC MP4 export), PRD §18 (packaging and codec complexity risk)

## Context

Two requirements are in tension. FR-04 says "Composition matches render for positioning and
basic transforms", and PRD §9 warns: "Avoid relying exclusively on browser video elements
for export parity." Meanwhile the scope boundary (PRD §4) explicitly excludes
"GPU effects parity with desktop NLEs", and PRD §18 flags "Desktop render packaging/codec
complexity" as a risk.

The PRD suggests Remotion for "deterministic effects/text and export orchestration", but
also states that licensing "must be reviewed" before distribution (PRD §19, decision 2).

## Decision

Compose and encode with a **single FFmpeg invocation** built from a shared, tested
composition spec.

- `buildFilterGraph(document, { preset, assets })` is a **pure function** that turns the
  timeline into a `filter_complex` string, an input list, and encode arguments. It has no
  FFmpeg dependency, so the entire composition contract is unit-testable on a machine
  without FFmpeg installed.
- Composition is expressed as `trim` → `setpts` → `scale`/`pad` → `crop` → `rotate` →
  `colorchannelmixer` (opacity) per clip, composited with `overlay ... enable='between(t,a,b)'`
  in track order, and audio as `atrim`/`asetpts`/`atempo`/`adelay`/`volume`/`afade` mixed
  with `amix`.
- **Identity stages are omitted.** A clip with no crop, no rotation and full opacity emits
  no crop, rotate or alpha filter. This keeps the graph readable, keeps FFmpeg fast, and —
  most importantly — makes a diff of the graph a meaningful signal in review.
- The render writes to a temp file and atomically renames on success (PRD §12).
- The browser canvas preview implements the _same_ spec (position, scale, rotation, opacity,
  crop) so preview and output agree. Export always renders from originals at project
  settings, never from proxies (PRD §12).

## Consequences

- Preview/export parity is a property of a shared, tested function rather than of two
  independent implementations hoping to agree. Golden-frame tests compare mean absolute
  pixel difference against a tolerance at sampled frames, because H.264 encoders legitimately
  differ between builds.
- The Rust host builds the identical graph for its render command. Two implementations of one
  spec is a real duplication risk; it is mitigated by (a) the spec being written down in
  `docs/ARCHITECTURE.md`, (b) Rust and TypeScript tests asserting the same expected filter
  strings for the same fixture timeline, and (c) golden frames catching any drift.
- The supported effect set at launch is deliberately small: transform, crop, opacity,
  speed, fades, and transitions. That is the honest reading of "carry reliable trimming,
  audio mixing and basic transforms before advanced NLE features" (PRD §18).
- Shipping a GPL FFmpeg build for libx264 is a licensing obligation, recorded in `LICENSE`.
  A fully permissive build would forbid H.264 and violate FR-09.
- Remotion remains an _optional_ future path for deterministic titles and text. Nothing in
  the current export path depends on it, so its licence review is not on the critical path.

## Alternatives considered

- **Composite in the browser with canvas/WebCodecs and mux.** Rejected by PRD §9, and it
  makes export quality hostage to the webview's codec support. WebCodecs availability and
  bitrate control are also inconsistent across platforms.
- **Play the timeline in a `<video>` element and capture the stream.** Rejected: seeking
  accuracy and frame-exactness are unreliable, and PRD §9 calls this out explicitly.
- **Remotion as the primary engine now.** Not rejected on merit — deferred. It adds a
  runtime, a bundler and a commercial licence question to the MVP's critical path while
  FFmpeg already satisfies FR-09.
- **Per-clip intermediate renders, then concat.** Rejected: it multiplies encode generations
  (visible quality loss on every export), loses cross-clip transitions, and is slower.
