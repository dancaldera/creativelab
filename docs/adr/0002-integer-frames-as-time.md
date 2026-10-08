# ADR 0002 — Integer frames and exact rationals as the only canonical time

- **Status:** accepted
- **Date:** 2026-10-07
- **Requirements:** PRD §10 ("Use integer frames or rational time for timeline coordinates,
  never floating-point seconds as canonical clip boundaries"), PRD §4 (24/25/30/60 fps
  presets), FR-03, FR-04

## Context

The editor must support 29.97 and 59.94 fps, which are not representable as decimal
floating point. A one-frame error at 29.97 fps is ~33 ms; accumulated across an hour-long
timeline it desynchronises audio from video. Every NLE bug report of the form "audio
drifts at the end" traces back to representing time as a float.

Timecode compounds the problem: 29.97 fps uses _drop-frame_ numbering, where frame numbers
`;00` and `;01` do not exist at the top of most minutes. Getting that wrong makes exported
EDLs and captions land on the wrong frame.

## Decision

Three representations, each with exactly one job:

1. **Integer frames** at the sequence's frame rate are the canonical coordinate for every
   clip boundary, duration, keyframe and playhead position.
2. **Exact rationals** (`{ num, den }`) represent frame rate and speed. 29.97 is
   `{ num: 30000, den: 1001 }`, never `29.97`.
3. **Floating-point seconds** exist only at boundaries: display, FFmpeg arguments, and
   provider API payloads. Every boundary conversion is named `*AsSeconds` / `*AsMs` /
   `toSeconds` so it is visible in review.

`packages/core/src/timebase.ts` owns all conversions. `FrameRate` values are reduced by
GCD, `secondsToFrames` requires an explicit rounding mode and rejects non-finite input, and
drop-frame timecode uses the standard `framesPer10Min` / `framesPerMin` algorithm with a
verified round trip.

Every edit operation asserts integer geometry. `assertTimelineInvariants` throws on a
non-integer `startFrame` or a non-positive `durationFrames`, so a float can never reach
the database.

## Consequences

- A/V sync is exact by construction, including at NTSC rates, and `convertFrames` preserves
  wall-clock duration when mixing 29.97 footage into a 25 fps project.
- Rounding is a visible decision at each boundary rather than an implicit truncation.
  `applyRounding` breaks ties away from zero so negative offsets behave symmetrically.
- The UI must render seconds for humans. That is a one-way conversion at the display layer;
  the frame index is never reconstructed from the displayed string.
- Frame-rate changes are a genuine retime, not a metadata edit. `convertFrames` and
  `retimeDuration` exist for that, and both are explicit about their rounding.
- Timecode formatting for 23.976 fps is non-drop only, matching industry practice, and the
  code refuses to _emit_ drop-frame for a rate where it is undefined rather than
  silently producing wrong numbers.

## Alternatives considered

- **Floating-point seconds as canonical.** Rejected: cannot represent 1001/30000 exactly;
  drift is guaranteed, and the PRD explicitly forbids it.
- **Rational time everywhere (e.g. `{num, den}` for every boundary).** Rejected: comparisons
  and equality become expensive and error-prone, and every NLE already counts frames.
  Rationals are used only where they are genuinely needed — rates and speeds.
- **Milliseconds as canonical.** Rejected: one frame at 60 fps is 16.67 ms, so milliseconds
  cannot express a frame boundary without a remainder.
- **Storing timecode strings.** Rejected: parsing and comparison are lossy and slow, and
  drop-frame makes the mapping many-to-one at skipped numbers.
