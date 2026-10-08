/**
 * Frame composition for the preview (FR-04: "Composition matches render for positioning
 * and basic transforms").
 *
 * ## Why this is a pure module
 *
 * The risky part of preview/render parity is the *geometry*, not the painting: which clips
 * are visible at a frame, which track wins, and which transform each contributes. That
 * geometry lives here as pure functions over the document so it can be unit-tested in the
 * node environment, and `PreviewCanvas` is left with nothing but `drawImage`-style
 * painting of the resulting plan. The same plan is the contract a Remotion composition and
 * the FFmpeg graph would consume on the native side.
 *
 * Track order follows the NLE convention: later `sortOrder` is drawn *behind* earlier
 * tracks, so V1 (sortOrder 0) composites on top of V2, and so on.
 */
import type { Asset, Clip, EditorDocument, Track } from "@creativelab/core";
import { clipEnd } from "../state/coreOps";

/** A clip's contribution at one frame, in composition-normalized coordinates. */
export interface FrameLayer {
  clipId: string;
  trackId: string;
  /** 0..1; 1 is fully opaque. */
  opacity: number;
  /** Visible fraction of the composition, after crop. */
  crop: { top: number; right: number; bottom: number; left: number };
  transform: {
    /** Offset in composition-normalized units (-1..1 spans the full frame width). */
    x: number;
    y: number;
    scale: number;
    rotation: number;
    flipX: boolean;
    flipY: boolean;
  };
  /** Populated when the clip has no asset or the asset went missing (FR-02). */
  missing: boolean;
  mediaType: Asset["mediaType"] | "placeholder";
  label: string;
  assetId: string | null;
}

export interface FramePlan {
  frame: number;
  width: number;
  height: number;
  /** Back-to-front paint order. */
  layers: FrameLayer[];
  /** Caption text that would be burned in at this frame, if any. */
  captions: string[];
  /** True when any visible video layer has no resolvable asset. */
  hasMissingMedia: boolean;
}

/** Clips whose timeline range contains `frame`. */
export function clipsAtFrame(document: EditorDocument, frame: number): Clip[] {
  return document.clips.filter((clip) => frame >= clip.startFrame && frame < clipEnd(clip));
}

function trackRank(document: EditorDocument, trackId: string): number {
  const track = document.tracks.find((candidate) => candidate.id === trackId);
  return track?.sortOrder ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Build the paint plan for one frame.
 *
 * Hidden tracks and disabled audio are excluded; a clip whose asset is unknown still
 * produces a layer (flagged `missing`) so the user sees the gap they are about to export.
 */
export function planFrame(document: EditorDocument, frame: number): FramePlan {
  const activeSequence = document.sequences.find((sequence) => sequence.isActive) ?? document.sequences[0];
  const width = activeSequence?.width ?? document.project.width;
  const height = activeSequence?.height ?? document.project.height;
  const assetsById = new Map(document.assets.map((asset) => [asset.id, asset]));
  const tracksById = new Map(document.tracks.map((track) => [track.id, track]));

  const visible = clipsAtFrame(document, frame).filter((clip) => {
    const track = tracksById.get(clip.trackId);
    if (!track || track.hidden) return false;
    return true;
  });

  const ordered = [...visible].sort((a, b) => trackRank(document, b.trackId) - trackRank(document, a.trackId));

  const layers: FrameLayer[] = [];
  const captions: string[] = [];
  let hasMissingMedia = false;

  for (const clip of ordered) {
    const track = tracksById.get(clip.trackId);
    const asset = clip.assetId ? assetsById.get(clip.assetId) : undefined;
    if (asset?.missingAt) hasMissingMedia = true;
    if (track?.kind === "caption") {
      const text = typeof clip.properties.notes === "string" && clip.properties.notes.length > 0 ? clip.properties.notes : clip.label;
      if (text) captions.push(text);
      continue;
    }
    if (track?.kind === "audio") continue;
    layers.push({
      clipId: clip.id,
      trackId: clip.trackId,
      opacity: clip.properties.transform.opacity,
      crop: { ...clip.properties.crop },
      transform: {
        x: clip.properties.transform.x,
        y: clip.properties.transform.y,
        scale: clip.properties.transform.scale,
        rotation: clip.properties.transform.rotation,
        flipX: clip.properties.transform.flipX,
        flipY: clip.properties.transform.flipY,
      },
      missing: !asset || Boolean(asset.missingAt),
      mediaType: asset?.mediaType ?? "placeholder",
      label: clip.label || "Clip",
      assetId: clip.assetId,
    });
  }

  return { frame, width, height, layers, captions, hasMissingMedia };
}

/**
 * Source time for a clip at a timeline frame, in seconds — what a real renderer asks the
 * decoder for. Speed-aware and clamped to the source span so the preview never asks for a
 * frame the asset does not have.
 */
export function sourceSecondsFor(clip: Clip, frame: number, asset: Asset | undefined, fps: { num: number; den: number }): number {
  const offset = Math.max(0, frame - clip.startFrame);
  const { num, den } = clip.properties.speed;
  const sourceFrame = clip.sourceInFrame + Math.floor((offset * num) / den);
  const bounded = asset?.durationFrames ? Math.min(sourceFrame, Math.max(0, asset.durationFrames - 1)) : sourceFrame;
  return (bounded * fps.den) / fps.num;
}

/** Which audio tracks are audible at a frame, honouring mute/solo (PRD §6). */
export function audibleTracksAtFrame(document: EditorDocument, frame: number): Track[] {
  const audio = document.tracks.filter((track) => track.kind === "audio");
  const anySolo = audio.some((track) => track.solo);
  return audio.filter((track) => {
    if (track.muted) return false;
    if (anySolo && !track.solo) return false;
    return document.clips.some((clip) => clip.trackId === track.id && frame >= clip.startFrame && frame < clipEnd(clip));
  });
}
