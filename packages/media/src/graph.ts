/**
 * Filter-graph builder — the single definition of how a timeline becomes an FFmpeg render.
 *
 * Everything here is **pure**: no filesystem, no processes, no clock. The same rules are
 * implemented in Rust for the native preview pipeline, so the emitted strings are a
 * contract: stage order, stage spelling and number formatting must match exactly.
 *
 * Conventions that the Rust side mirrors:
 *   - numbers are formatted with `toFixed(6)` and trailing zeros stripped (`5.005`, `2`);
 *   - identity stages are omitted entirely (no `crop`/`rotate`/`colorchannelmixer`/
 *     `atempo`/`adelay`/`volume`/fade no-ops), because a graph full of no-op filters is
 *     both slower and impossible to diff;
 *   - one `-i` per distinct asset, in the order of `inputs`, so `[i:v]` / `[i:a]` line up
 *     with the argument list the renderer builds.
 */
import {
  clipEnd,
  frameRate,
  framesToSeconds,
  secondsToFrames,
  sequenceDurationFrames,
  sourceRange,
} from "@creativelab/core";
import type { Clip, EditorDocument, ExportPreset, FrameRate, Track } from "@creativelab/core";
import { MediaError } from "./errors.js";

/** What the graph needs to know about one asset. */
export interface GraphAssetInfo {
  /** Absolute path passed to `-i`. */
  path: string;
  /** Frames available in the source, for `sourceRange` validation. */
  durationFrames?: number;
  /** False when the file has no audio stream (its audio clips are then skipped). */
  hasAudio?: boolean;
  width?: number;
  height?: number;
  fps?: FrameRate;
}

export type AssetResolver =
  ReadonlyMap<string, GraphAssetInfo> | ((assetId: string) => GraphAssetInfo | undefined);

export interface BuildFilterGraphOptions {
  preset: ExportPreset;
  assets: AssetResolver;
}

export interface ExportFilterGraph {
  /** Values for `-i`, in the order that fixes every `[index:stream]` reference. */
  inputs: string[];
  /** The whole `-filter_complex` argument. */
  filterComplex: string;
  /** Stream specifiers for `-map`, video first. */
  maps: string[];
  /** Codec/muxer arguments (no input, filter or output path). */
  encodeArgs: string[];
  /** Frames the encoder will produce at the preset rate. */
  totalFrames: number;
  /** Timeline duration in seconds at the sequence rate. */
  durationSeconds: number;
}

const RADIANS_PER_DEGREE = Math.PI / 180;
const MAX_DECIMALS = 6;

/**
 * Deterministic numeric formatting for filter expressions: fixed decimals, no exponent,
 * no trailing zeros, no `-0`.
 */
export function formatFilterNumber(value: number, decimals = MAX_DECIMALS): string {
  if (!Number.isFinite(value)) {
    throw new MediaError(`Cannot express ${value} in a filter graph`, { category: "validation" });
  }
  let text = value.toFixed(decimals);
  if (text.includes("e") || text.includes("E")) text = value.toString();
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  if (text === "-0" || text === "") text = "0";
  return text;
}

/** Signed offset term, e.g. `+120` or `-40` (never `+-40`). */
function signedOffset(value: number): string {
  return value < 0 ? `-${formatFilterNumber(Math.abs(value))}` : `+${formatFilterNumber(value)}`;
}

/**
 * `atempo` only accepts 0.5–2.0 per instance, so larger factors are chained.
 *
 * Values are exact ratios (`num/den`) in practice, which keeps the halving loops short
 * and the resulting strings stable.
 */
export function buildAtempoChain(speed: number): string[] {
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new MediaError(`Clip speed must be positive, received ${speed}`, {
      category: "validation",
    });
  }
  if (speed === 1) return [];
  const steps: number[] = [];
  let remaining = speed;
  // Guarded loops: the epsilon prevents a float 2.0000000001 from adding a useless step.
  while (remaining > 2 + 1e-9) {
    steps.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5 - 1e-9) {
    steps.push(0.5);
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1) > 1e-9) steps.push(remaining);
  return steps.map((step) => `atempo=${formatFilterNumber(step)}`);
}

function resolveAssetSource(
  assets: AssetResolver,
): (assetId: string) => GraphAssetInfo | undefined {
  if (typeof assets === "function") return assets;
  return (assetId) => assets.get(assetId);
}

function trackOrder(track: Track | undefined): number {
  return track?.sortOrder ?? 0;
}

function compareClips(
  a: { clip: Clip; track: Track | undefined },
  b: { clip: Clip; track: Track | undefined },
): number {
  return (
    trackOrder(a.track) - trackOrder(b.track) ||
    a.clip.startFrame - b.clip.startFrame ||
    a.clip.id.localeCompare(b.clip.id)
  );
}

/** `crop=w:h:x:y` derived from the source-normalized crop fractions. */
export function cropStage(clip: Clip, width: number, height: number): string | undefined {
  const { top, right, bottom, left } = clip.properties.crop;
  if (top === 0 && right === 0 && bottom === 0 && left === 0) return undefined;
  // A fully-cropped axis is invalid for FFmpeg; clamp to one pixel rather than emit `crop=0`.
  const cropWidth = Math.max(1, (1 - left - right) * width);
  const cropHeight = Math.max(1, (1 - top - bottom) * height);
  const dimensions = [
    formatFilterNumber(cropWidth),
    formatFilterNumber(cropHeight),
    formatFilterNumber(left * width),
    formatFilterNumber(top * height),
  ].join(":");
  return `crop=${dimensions}`;
}

/** `rotate=rad:ow=rotw(rad):oh=roth(rad):c=none`, omitted when the clip is not rotated. */
export function rotationStage(clip: Clip): string | undefined {
  const degrees = clip.properties.transform.rotation;
  if (degrees === 0) return undefined;
  const radians = formatFilterNumber(degrees * RADIANS_PER_DEGREE);
  return `rotate=${radians}:ow=rotw(${radians}):oh=roth(${radians}):c=none`;
}

/**
 * `scale=iw*S:ih*S` — the clip's `transform.scale`, omitted at 1.
 *
 * This is *not* the fit-to-composition scale above: that one letterboxes the source into the
 * composition, this one then resizes the result by the user's transform. The preview
 * (`PreviewCanvas.paintLayer`) applies it via `context.scale`, so leaving it out of the graph
 * made a scaled clip render at full size in the export — a preview/export parity break
 * (FR-04), which `golden.test.ts` catches by sampling pixels.
 */
export function transformScaleStage(clip: Clip): string | undefined {
  const { scale } = clip.properties.transform;
  if (scale === 1) return undefined;
  if (!Number.isFinite(scale) || scale <= 0) return undefined;
  const factor = formatFilterNumber(scale);
  return `scale=iw*${factor}:ih*${factor}`;
}

/**
 * `hflip` / `vflip` — the clip's mirror flags, omitted when neither is set.
 *
 * Emitted immediately before rotation, matching both the schema's "Mirror flags, applied
 * before rotation" and the preview's `context.scale(±scale, ±scale)` before drawing.
 */
export function flipStage(clip: Clip): string | undefined {
  const { flipX, flipY } = clip.properties.transform;
  if (!flipX && !flipY) return undefined;
  const stages: string[] = [];
  if (flipX) stages.push("hflip");
  if (flipY) stages.push("vflip");
  return stages.join(",");
}

/** `colorchannelmixer=aa=<opacity>`, omitted when the clip is fully opaque. */
export function opacityStage(clip: Clip): string | undefined {
  const { opacity } = clip.properties.transform;
  if (opacity >= 1) return undefined;
  return `colorchannelmixer=aa=${formatFilterNumber(opacity)}`;
}

interface ParticipatingClip {
  clip: Clip;
  track: Track;
  asset: GraphAssetInfo;
  inputIndex: number;
}

/**
 * Build the complete render description for a document.
 *
 * Throws `MediaError` for the three cases the renderer must never guess about: an empty
 * timeline, a clip whose asset is unknown, and a clip whose source range runs past the
 * end of its asset.
 */
export function buildFilterGraph(
  document: EditorDocument,
  options: BuildFilterGraphOptions,
): ExportFilterGraph {
  const { preset } = options;
  const resolve = resolveAssetSource(options.assets);

  const sequence =
    document.sequences.find((candidate) => candidate.isActive) ?? document.sequences[0];
  if (sequence === undefined) {
    throw new MediaError("Cannot render a document without a sequence", { category: "validation" });
  }
  // The *sequence* rate is the timeline's timebase and the thing clip boundaries are
  // expressed in. A preset only overrides it when it names a rate explicitly; the shipped
  // presets leave `fps` null so that exporting a 25 fps project produces a 25 fps file
  // rather than silently resampling it (PRD §12: "export always renders at project
  // settings"). Resampling here would also break preview/export parity (FR-04), because
  // the preview plays at the sequence rate.
  const fps = frameRate(sequence.fps.num, sequence.fps.den);
  const presetFps = preset.fps === null ? fps : frameRate(preset.fps.num, preset.fps.den);

  const clips = document.clips.filter((clip) => clip.sequenceId === sequence.id);
  if (clips.length === 0) {
    throw new MediaError("Cannot render an empty timeline: the sequence has no clips", {
      category: "validation",
      details: { sequenceId: sequence.id },
    });
  }
  const timelineFrames = sequenceDurationFrames(clips);
  if (timelineFrames <= 0) {
    throw new MediaError("Cannot render an empty timeline: its duration is zero frames", {
      category: "validation",
      details: { sequenceId: sequence.id },
    });
  }

  const trackById = new Map(document.tracks.map((track) => [track.id, track]));
  const anyAudioSolo = document.tracks.some((track) => track.kind === "audio" && track.solo);

  const videoSelection: { clip: Clip; track: Track; asset: GraphAssetInfo }[] = [];
  const audioSelection: { clip: Clip; track: Track; asset: GraphAssetInfo }[] = [];

  for (const clip of clips) {
    const track = trackById.get(clip.trackId);
    if (track === undefined) {
      throw new MediaError(`Clip ${clip.id} references unknown track ${clip.trackId}`, {
        category: "validation",
      });
    }
    if (track.kind !== "video" && track.kind !== "audio") continue;

    const assetId = clip.assetId;
    if (assetId === null) {
      throw new MediaError(`Clip ${clip.id} has no asset; cannot render it`, {
        category: "validation",
        details: { clipId: clip.id, trackId: clip.trackId },
      });
    }
    const asset = resolve(assetId);
    if (asset === undefined) {
      throw new MediaError(`Clip ${clip.id} references a missing asset ${assetId}`, {
        category: "validation",
        details: { clipId: clip.id, assetId },
      });
    }

    const range = sourceRange(clip);
    if (asset.durationFrames !== undefined && range.end > asset.durationFrames) {
      throw new MediaError(
        `Clip ${clip.id} needs source frames [${range.start}, ${range.end}) but asset ${assetId} has only ${asset.durationFrames}`,
        {
          category: "validation",
          details: {
            clipId: clip.id,
            assetId,
            sourceEnd: range.end,
            assetDurationFrames: asset.durationFrames,
          },
        },
      );
    }

    if (track.kind === "video") {
      if (track.hidden) continue;
      videoSelection.push({ clip, track, asset });
    } else {
      // `enabled: false` removes a clip from the mix without unlinking it (core schema).
      if (!clip.properties.audio.enabled) continue;
      if (track.hidden || (track.muted && !track.solo) || (anyAudioSolo && !track.solo)) continue;
      if (asset.hasAudio === false) continue;
      audioSelection.push({ clip, track, asset });
    }
  }

  videoSelection.sort(compareClips);
  audioSelection.sort(compareClips);

  // One input per distinct asset, video clips first so `[i:v]` indexes read naturally.
  const inputs: string[] = [];
  const inputIndexByAsset = new Map<string, number>();
  const inputIndexFor = (assetId: string, asset: GraphAssetInfo): number => {
    const existing = inputIndexByAsset.get(assetId);
    if (existing !== undefined) return existing;
    const index = inputs.length;
    inputs.push(asset.path);
    inputIndexByAsset.set(assetId, index);
    return index;
  };

  const videoClips: ParticipatingClip[] = videoSelection.map((entry) => ({
    ...entry,
    inputIndex: inputIndexFor(entry.clip.assetId!, entry.asset),
  }));
  const audioClips: ParticipatingClip[] = audioSelection.map((entry) => ({
    ...entry,
    inputIndex: inputIndexFor(entry.clip.assetId!, entry.asset),
  }));

  const width = preset.width;
  const height = preset.height;
  const durationSeconds = framesToSeconds(timelineFrames, fps);
  const durationText = formatFilterNumber(durationSeconds);

  const stages: string[] = [];
  // The composition base is a generated black frame at the preset rate and full duration;
  // every video clip is composited onto it, so gaps render as black rather than as a gap.
  stages.push(
    `color=c=black:s=${width}x${height}:r=${presetFps.num}/${presetFps.den}:d=${durationText}[base]`,
  );

  videoClips.forEach((entry, index) => {
    const { clip, inputIndex } = entry;
    const { speed } = clip.properties;
    const sourceInSeconds = framesToSeconds(clip.sourceInFrame, fps);
    const clipSeconds = framesToSeconds(clip.durationFrames, fps);
    const speedRatio = speed.num / speed.den;

    const chain: string[] = [
      `trim=start=${formatFilterNumber(sourceInSeconds)}:duration=${formatFilterNumber(clipSeconds)}`,
      `setpts=(PTS-STARTPTS)/${formatFilterNumber(speedRatio)}`,
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    ];
    const crop = cropStage(clip, width, height);
    if (crop) chain.push(crop);
    // `transform.scale` and the mirror flags come after crop and before rotation. Reading
    // the preview's canvas transforms from the image's point of view — translate, then
    // rotate, then scale(±scale) about the origin — the source is cropped, resized, mirrored
    // and only then rotated. Omitting either stage here silently disagreed with the preview.
    const transformScale = transformScaleStage(clip);
    if (transformScale) chain.push(transformScale);
    const flip = flipStage(clip);
    if (flip) chain.push(flip);
    const rotation = rotationStage(clip);
    if (rotation) chain.push(rotation);
    chain.push("format=rgba");
    const opacity = opacityStage(clip);
    if (opacity) chain.push(opacity);

    stages.push(`[${inputIndex}:v]${chain.join(",")}[v${index}]`);

    const { transform } = clip.properties;
    const startSeconds = framesToSeconds(clip.startFrame, fps);
    const endSeconds = framesToSeconds(clipEnd(clip), fps);
    const x = `(${width}-w)/2${signedOffset(transform.x)}`;
    const y = `(${height}-h)/2${signedOffset(transform.y)}`;
    stages.push(
      `[base][v${index}]overlay=x=${x}:y=${y}:enable='between(t,${formatFilterNumber(startSeconds)},${formatFilterNumber(endSeconds)})'[base]`,
    );
  });

  audioClips.forEach((entry, index) => {
    const { clip, inputIndex } = entry;
    const { speed, audio } = clip.properties;
    const sourceInSeconds = framesToSeconds(clip.sourceInFrame, fps);
    const clipSeconds = framesToSeconds(clip.durationFrames, fps);
    const delayMs = Math.round(framesToSeconds(clip.startFrame, fps) * 1000);
    const speedRatio = speed.num / speed.den;

    const chain: string[] = [
      `atrim=start=${formatFilterNumber(sourceInSeconds)}:duration=${formatFilterNumber(clipSeconds)}`,
      "asetpts=PTS-STARTPTS",
      ...buildAtempoChain(speedRatio),
    ];
    if (delayMs > 0) chain.push(`adelay=${delayMs}|${delayMs}`);
    if (audio.gainDb !== 0) {
      chain.push(`volume=${formatFilterNumber(10 ** (audio.gainDb / 20))}`);
    }
    const fadeInSeconds = framesToSeconds(audio.fadeInFrames, fps);
    if (audio.fadeInFrames > 0 && fadeInSeconds > 0) {
      chain.push(`afade=t=in:st=0:d=${formatFilterNumber(fadeInSeconds)}`);
    }
    const fadeOutSeconds = framesToSeconds(audio.fadeOutFrames, fps);
    if (audio.fadeOutFrames > 0 && fadeOutSeconds > 0) {
      // The fade is computed on the delayed timeline, which is where the audio actually is.
      const fadeOutStart = Math.max(0, delayMs / 1000 + clipSeconds - fadeOutSeconds);
      chain.push(
        `afade=t=out:st=${formatFilterNumber(fadeOutStart)}:d=${formatFilterNumber(fadeOutSeconds)}`,
      );
    }

    // Every audio chain is mixed, even a single one, so the graph shape never depends on
    // how many audio clips happen to exist.
    stages.push(`[${inputIndex}:a]${chain.join(",")}[a${index}]`);
  });

  if (audioClips.length === 0) {
    // The preset always carries an AAC track, so an audio-only silent base keeps the
    // output shape stable for players and for the preview parity check (FR-04).
    const sampleRate = document.project.sampleRate;
    stages.push(
      `anullsrc=channel_layout=stereo:sample_rate=${sampleRate},atrim=duration=${durationText},asetpts=PTS-STARTPTS[aout]`,
    );
  } else {
    stages.push(
      `[${audioClips.map((_, index) => `a${index}`).join("][")}]amix=inputs=${audioClips.length}:normalize=0:dropout_transition=0[aout]`,
    );
  }

  const encodeArgs: string[] = [
    "-c:v",
    "libx264",
    "-pix_fmt",
    preset.pixelFormat,
    "-preset",
    preset.crf === null ? "medium" : "veryfast",
  ];
  if (preset.crf === null) {
    encodeArgs.push("-b:v", `${preset.videoBitrateKbps}k`);
  } else {
    encodeArgs.push("-crf", String(preset.crf));
  }
  encodeArgs.push(
    "-c:a",
    "aac",
    "-b:a",
    `${preset.audioBitrateKbps}k`,
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-shortest",
  );

  return {
    inputs,
    filterComplex: stages.join(";"),
    maps: ["[base]", "[aout]"],
    encodeArgs,
    totalFrames: secondsToFrames(durationSeconds, presetFps),
    durationSeconds,
  };
}
