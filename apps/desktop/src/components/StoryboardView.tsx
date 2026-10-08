/**
 * `StoryboardView` — ordered shots with text, duration, prompt and reference image, plus
 * "convert to timeline without flattening" (PRD §6).
 *
 * "Without flattening" is a real constraint, not a slogan: conversion creates *separate*
 * clips (one per shot, on the default track for its kind) and never merges, bakes or
 * rasterises anything. Reordering the storyboard afterwards reorders only the plan, leaving
 * the existing clips untouched.
 */
import { useState } from "react";
import type { Asset } from "@creativelab/core";
import { ASPECT_PRESETS_LOCAL } from "../state/coreOps";
import { createClip, placeClip } from "../state/clipFactory";
import { useEditorStore } from "../state/editorStore";
import { useUiStore } from "../state/uiStore";
import { insertAssetAt } from "./Timeline";
import { formatBytes } from "../utils/format";
import { useAssetThumbnail } from "./PreviewCanvas";

export interface StoryboardShot {
  id: string;
  label: string;
  prompt: string;
  durationSeconds: number;
  referenceAssetId: string | null;
}

const SEED_SHOTS: StoryboardShot[] = [
  { id: "shot-1", label: "Opening", prompt: "Wide establishing shot, golden hour", durationSeconds: 4, referenceAssetId: null },
  { id: "shot-2", label: "Subject", prompt: "Medium shot, subject enters frame left", durationSeconds: 3, referenceAssetId: null },
  { id: "shot-3", label: "Detail", prompt: "Macro detail, slow rack focus", durationSeconds: 2.5, referenceAssetId: null },
  { id: "shot-4", label: "Payoff", prompt: "Reverse angle, warm practical lights", durationSeconds: 4.5, referenceAssetId: null },
];

export function StoryboardView() {
  const document = useEditorStore((state) => state.document);
  const workspacePath = useEditorStore((state) => state.workspacePath);
  const showToast = useUiStore((state) => state.showToast);
  const setStoryboardOpen = useUiStore((state) => state.setStoryboardOpen);

  const [shots, setShots] = useState<StoryboardShot[]>(SEED_SHOTS);
  const [converting, setConverting] = useState(false);

  const sequence = document.sequences.find((candidate) => candidate.isActive) ?? document.sequences[0];
  const fps = sequence?.fps ?? document.project.fps;
  const framesPerSecond = fps.num / fps.den;

  const totalSeconds = shots.reduce((total, shot) => total + shot.durationSeconds, 0);

  const move = (index: number, direction: -1 | 1): void => {
    setShots((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      const [moving] = next.splice(index, 1);
      if (!moving) return current;
      next.splice(target, 0, moving);
      return next;
    });
  };

  const patch = (id: string, changes: Partial<StoryboardShot>): void => {
    setShots((current) => current.map((shot) => (shot.id === id ? { ...shot, ...changes } : shot)));
  };

  /**
   * Convert the plan into timeline clips.
   *
   * Each shot becomes exactly one clip on the first unlocked track of its kind; the shots are
   * laid end-to-end on that track. Nothing is merged, nothing is rendered, and every clip
   * remains individually editable afterwards.
   */
  const convertToTimeline = (): void => {
    if (shots.length === 0) return;
    setConverting(true);
    try {
      const state = useEditorStore.getState();
      const track = state.document.tracks.filter((candidate) => candidate.kind === "video" && !candidate.locked).sort((a, b) => a.sortOrder - b.sortOrder)[0];
      if (!track) {
        showToast("No unlocked video track to convert into.", "warn");
        return;
      }
      let cursor = 0;
      const created: number[] = [];
      for (const shot of shots) {
        const durationFrames = Math.max(1, Math.round(shot.durationSeconds * framesPerSecond));
        state.applyEdit(`Storyboard: ${shot.label}`, (current) =>
          placeClip(
            current,
            createClip({
              trackId: track.id,
              sequenceId: track.sequenceId,
              assetId: shot.referenceAssetId,
              label: shot.label,
              notes: shot.prompt,
              startFrame: cursor,
              durationFrames,
            }),
          ),
        );
        created.push(durationFrames);
        cursor += durationFrames;
      }
      showToast(`Created ${created.length} separate clips (${cursor} frames) without merging anything.`, "info");
      setStoryboardOpen(false);
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="panel-scroll" style={{ maxHeight: "100%" }}>
      <div className="panel-toolbar">
        <button type="button" className="btn btn--primary" onClick={convertToTimeline} disabled={converting || shots.length === 0}>
          {converting ? "Converting…" : "Convert to timeline"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            setShots((current) => [
              ...current,
              { id: `shot-${Date.now().toString(36)}`, label: `Shot ${current.length + 1}`, prompt: "", durationSeconds: 3, referenceAssetId: null },
            ])
          }
        >
          Add shot
        </button>
        <div className="spacer" />
        <span className="badge">
          {shots.length} shots · {totalSeconds.toFixed(1)}s · {ASPECT_PRESETS_LOCAL.find((preset) => preset.width === document.project.width && preset.height === document.project.height)?.label ?? "custom"}
        </span>
      </div>

      <p className="small muted">
        Conversion creates one clip per shot on the first unlocked video track. Shots are never merged into a single flattened asset, so each
        one stays trimmable, replaceable and regenerable.
      </p>

      <div className="storyboard">
        {shots.map((shot, index) => (
          <article className="storyboard__shot" key={shot.id}>
            <header className="storyboard__shot-header">
              <span className="storyboard__shot-index">#{index + 1}</span>
              <div className="row">
                <button type="button" className="btn btn--ghost btn--icon" aria-label={`Move ${shot.label} earlier`} onClick={() => move(index, -1)}>
                  ▲
                </button>
                <button type="button" className="btn btn--ghost btn--icon" aria-label={`Move ${shot.label} later`} onClick={() => move(index, 1)}>
                  ▼
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--icon"
                  aria-label={`Remove ${shot.label}`}
                  onClick={() => setShots((current) => current.filter((candidate) => candidate.id !== shot.id))}
                >
                  ✕
                </button>
              </div>
            </header>

            <ShotReference shot={shot} workspacePath={workspacePath} />

            <div className="field">
              <label htmlFor={`shot-label-${shot.id}`}>Shot name</label>
              <input
                id={`shot-label-${shot.id}`}
                className="input"
                value={shot.label}
                onChange={(event) => patch(shot.id, { label: event.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor={`shot-prompt-${shot.id}`}>Prompt</label>
              <textarea
                id={`shot-prompt-${shot.id}`}
                className="textarea"
                style={{ minHeight: 58 }}
                value={shot.prompt}
                onChange={(event) => patch(shot.id, { prompt: event.target.value })}
              />
            </div>

            <div className="field">
              <label htmlFor={`shot-duration-${shot.id}`}>Duration (s)</label>
              <input
                id={`shot-duration-${shot.id}`}
                className="input"
                type="number"
                min={0.5}
                step={0.5}
                value={shot.durationSeconds}
                onChange={(event) => patch(shot.id, { durationSeconds: Math.max(0.5, Number(event.target.value) || 0.5) })}
              />
            </div>

            <div className="field">
              <label htmlFor={`shot-reference-${shot.id}`}>Reference image</label>
              <select
                id={`shot-reference-${shot.id}`}
                className="select"
                value={shot.referenceAssetId ?? ""}
                onChange={(event) => patch(shot.id, { referenceAssetId: event.target.value || null })}
              >
                <option value="">None</option>
                {document.assets
                  .filter((asset) => asset.mediaType === "image")
                  .map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.relativePath?.split("/").pop() ?? asset.id}
                    </option>
                  ))}
              </select>
            </div>

            {document.assets.length > 0 ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const first = document.assets[0];
                  if (!first) return;
                  insertAssetAt(first.id, 0, null, fps);
                  showToast(`Appended ${first.mediaType} asset to the timeline at frame 0.`, "info");
                }}
              >
                Append library asset
              </button>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

function ShotReference({ shot, workspacePath }: { shot: StoryboardShot; workspacePath: string | null }) {
  const asset = useEditorStore((state) => state.document.assets.find((candidate) => candidate.id === shot.referenceAssetId));
  const thumbnail = useAssetThumbnail(asset, workspacePath);

  if (!shot.referenceAssetId || !asset) {
    return (
      <div className="storyboard__thumb storyboard__placeholder" aria-hidden="true">
        no reference
      </div>
    );
  }
  return thumbnail.data?.relativePath ? (
    <img className="storyboard__thumb" src={thumbnail.data.relativePath} alt={`Reference for ${shot.label}`} />
  ) : (
    <div className="storyboard__thumb storyboard__placeholder" aria-hidden="true">
      {asset.mediaType} · {formatBytes(asset.bytes)}
    </div>
  );
}

/** A storyboard shot's timeline footprint in frames, used by tests and the converter. */
export function shotDurationFrames(shot: StoryboardShot, fps: { num: number; den: number }): number {
  return Math.max(1, Math.round(shot.durationSeconds * (fps.num / fps.den)));
}

export type { Asset };
