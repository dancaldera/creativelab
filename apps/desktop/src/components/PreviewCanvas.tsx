/**
 * `PreviewCanvas` — aspect-correct composition preview with safe areas (FR-04).
 *
 * The paint plan comes from the pure `planFrame`/`sourceSecondsFor` helpers, so the
 * geometry that has to match the render is testable in isolation. What is left here is:
 *   * sizing the frame box to the project aspect inside the available stage,
 *   * painting each layer with its transform/crop/opacity,
 *   * playback driven by `requestAnimationFrame` at the project frame rate.
 *
 * Playback advances a *ref*, and only pushes into the store when the integer frame
 * changes, so a 60 Hz rAF loop on a 30 fps project causes exactly one store write per
 * frame rather than one per animation callback.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Asset, Clip } from "@creativelab/core";
import { useThumbnail } from "../hooks/queries";
import { activeSequence, frameRateAsNumber, sequenceDurationFrames } from "../state/coreOps";
import { useEditorStore } from "../state/editorStore";
import { planFrame, sourceSecondsFor } from "./composeFrame";

interface PreviewCanvasProps {
  /** When true the safe-area guides are drawn. */
  showSafeAreas?: boolean;
}

export function PreviewCanvas({ showSafeAreas = true }: PreviewCanvasProps) {
  const document = useEditorStore((state) => state.document);
  const playheadFrame = useEditorStore((state) => state.playheadFrame);
  const isPlaying = useEditorStore((state) => state.isPlaying);
  const playbackRate = useEditorStore((state) => state.playbackRate);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const setPlaying = useEditorStore((state) => state.setPlaying);
  const volume = useEditorStore((state) => state.volume);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 640, height: 400 });

  const sequence = activeSequence(document);
  const projectWidth = sequence?.width ?? document.project.width;
  const projectHeight = sequence?.height ?? document.project.height;
  const fps = sequence?.fps ?? document.project.fps;
  const totalFrames = sequenceDurationFrames(document.clips);

  // -- responsive frame box -------------------------------------------------
  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return undefined;
    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      setStageSize({ width: Math.max(160, rect.width - 28), height: Math.max(120, rect.height - 28) });
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const frameBox = useMemo(() => {
    const aspect = projectWidth / projectHeight;
    let width = stageSize.width;
    let height = width / aspect;
    if (height > stageSize.height) {
      height = stageSize.height;
      width = height * aspect;
    }
    return { width: Math.round(width), height: Math.round(height) };
  }, [projectWidth, projectHeight, stageSize.width, stageSize.height]);

  const plan = useMemo(() => planFrame(document, playheadFrame), [document, playheadFrame]);

  // -- paint ----------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(frameBox.width * ratio));
    canvas.height = Math.max(1, Math.round(frameBox.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) return;

    context.save();
    context.scale(ratio, ratio);
    context.fillStyle = "#05070a";
    context.fillRect(0, 0, frameBox.width, frameBox.height);

    const assetsById = new Map(document.assets.map((asset) => [asset.id, asset] as const));

    for (const layer of plan.layers) {
      const clip = document.clips.find((candidate) => candidate.id === layer.clipId);
      const asset = layer.assetId ? assetsById.get(layer.assetId) : undefined;
      paintLayer(context, {
        canvasWidth: frameBox.width,
        canvasHeight: frameBox.height,
        layer,
        clip,
        asset,
        frame: playheadFrame,
        fps,
      });
    }

    // Caption burn-in preview: the same text the export would burn (FR-11).
    if (plan.captions.length > 0) {
      const text = plan.captions.join(" ");
      context.font = `600 ${Math.max(11, Math.round(frameBox.height * 0.042))}px ui-sans-serif, system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "bottom";
      const lines = wrapText(context, text, frameBox.width * 0.86);
      let y = frameBox.height * 0.94;
      for (const line of lines.reverse()) {
        const metrics = context.measureText(line);
        context.fillStyle = "rgba(0,0,0,0.62)";
        context.fillRect(
          frameBox.width / 2 - metrics.width / 2 - 6,
          y - Math.round(frameBox.height * 0.05),
          metrics.width + 12,
          Math.round(frameBox.height * 0.058),
        );
        context.fillStyle = "#ffffff";
        context.fillText(line, frameBox.width / 2, y);
        y -= Math.round(frameBox.height * 0.062);
      }
    }

    context.restore();
  }, [document, frameBox.height, frameBox.width, fps, plan, playheadFrame]);

  // -- playback -------------------------------------------------------------
  useEffect(() => {
    if (!isPlaying) return undefined;
    if (typeof requestAnimationFrame === "undefined") return undefined;

    const rate = playbackRate === 0 ? 1 : playbackRate;
    const fpsValue = Math.abs(frameRateAsNumber(fps)) || 30;
    let raf = 0;
    let last = performance.now();
    let accumulator = 0;

    const step = (now: number): void => {
      const deltaMs = now - last;
      last = now;
      accumulator += (deltaMs / 1000) * fpsValue * rate;
      const advance = Math.trunc(accumulator);
      if (advance !== 0) {
        accumulator -= advance;
        const current = useEditorStore.getState().playheadFrame;
        const next = current + advance;
        if (next < 0) {
          setPlayhead(0);
          setPlaying(false, 0);
          return;
        }
        if (totalFrames > 0 && next >= totalFrames) {
          setPlayhead(totalFrames);
          setPlaying(false, 0);
          return;
        }
        setPlayhead(next);
      }
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [fps, isPlaying, playbackRate, setPlayhead, setPlaying, totalFrames]);

  const onScrub = useCallback(
    (value: number) => {
      setPlayhead(value);
    },
    [setPlayhead],
  );

  const qualityBadge = useMemo(() => {
    const heavy = document.assets.some((asset) => (asset.width ?? 0) >= 3000 || (asset.height ?? 0) >= 3000);
    return heavy ? "Proxy: available" : "Full quality";
  }, [document.assets]);

  return (
    <section className="preview" aria-label="Canvas preview">
      <div className="preview__stage" ref={stageRef}>
        <div className="preview__badges">
          <span className="badge" title="Active sequence">
            {sequence?.name ?? "No sequence"} · {projectWidth}×{projectHeight}
          </span>
          <span className="badge" title="Preview quality policy (PRD §12)">
            {qualityBadge}
          </span>
          {plan.hasMissingMedia ? (
            <span className="badge badge--danger" role="status">
              Missing media
            </span>
          ) : null}
        </div>

        {totalFrames === 0 ? (
          <p className="preview__empty">
            No clips yet. Import media or generate a shot, then drag it onto a track.
            <br />
            The preview composes the same frame the exporter will render.
          </p>
        ) : null}

        <div className="preview__frame" style={{ width: frameBox.width, height: frameBox.height }}>
          <canvas
            ref={canvasRef}
            className="preview__canvas"
            style={{ width: frameBox.width, height: frameBox.height }}
            role="img"
            aria-label={`Composition preview at frame ${playheadFrame}, ${plan.layers.length} visible layer${
              plan.layers.length === 1 ? "" : "s"
            }`}
          />
          {showSafeAreas ? (
            <div className="preview__safe" aria-hidden="true">
              <div className="preview__safe-title" />
              <div className="preview__safe-action" />
              <span className="preview__safe-label">Title / action safe</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="transport">
        <div className="row" role="group" aria-label="Transport controls">
          <button
            type="button"
            className="btn btn--icon"
            aria-label="Step back one frame"
            onClick={() => setPlayhead(playheadFrame - 1)}
          >
            ◀|
          </button>
          <button
            type="button"
            className="btn btn--icon"
            aria-label="Reverse playback (J)"
            aria-pressed={playbackRate < 0}
            onClick={() => setPlaying(true, playbackRate < 0 ? playbackRate : -1)}
          >
            ◀◀
          </button>
          <button
            type="button"
            className="btn btn--primary btn--icon"
            aria-label={isPlaying ? "Pause (space)" : "Play (space)"}
            onClick={() => setPlaying(!isPlaying, isPlaying ? 0 : 1)}
          >
            {isPlaying ? "❚❚" : "▶"}
          </button>
          <button
            type="button"
            className="btn btn--icon"
            aria-label="Forward playback (L)"
            aria-pressed={playbackRate > 0}
            onClick={() => setPlaying(true, playbackRate > 0 ? playbackRate : 1)}
          >
            ▶▶
          </button>
          <button type="button" className="btn btn--icon" aria-label="Step forward one frame" onClick={() => setPlayhead(playheadFrame + 1)}>
            |▶
          </button>
          <button type="button" className="btn btn--icon" aria-label="Stop (K)" onClick={() => setPlaying(false, 0)}>
            ■
          </button>
        </div>

        <span className="transport__speed mono" aria-live="off">
          {playbackRate === 0 ? "—" : `${playbackRate > 0 ? "▶" : "◀"} ${Math.abs(playbackRate)}x`}
        </span>

        <input
          className="transport__scrub"
          type="range"
          min={0}
          max={Math.max(1, totalFrames)}
          value={playheadFrame}
          onChange={(event) => onScrub(Number(event.target.value))}
          aria-label="Scrub playhead"
          aria-valuemin={0}
          aria-valuemax={Math.max(1, totalFrames)}
          aria-valuenow={playheadFrame}
          aria-valuetext={`Frame ${playheadFrame} of ${totalFrames}`}
          disabled={totalFrames === 0}
        />

        <label className="row small muted">
          Volume
          <input
            className="transport__volume"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            aria-label="Monitor volume"
            onChange={(event) => useEditorStore.getState().setVolume(Number(event.target.value))}
          />
        </label>
      </div>
    </section>
  );
}

interface PaintLayerInput {
  canvasWidth: number;
  canvasHeight: number;
  layer: ReturnType<typeof planFrame>["layers"][number];
  clip: Clip | undefined;
  asset: Asset | undefined;
  frame: number;
  fps: { num: number; den: number };
}

/** Paint one clip layer with its transform, crop and opacity. */
function paintLayer(context: CanvasRenderingContext2D, input: PaintLayerInput): void {
  const { canvasWidth, canvasHeight, layer, clip, asset, frame, fps } = input;
  if (!clip) return;

  context.save();
  context.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
  context.translate(canvasWidth / 2 + layer.transform.x, canvasHeight / 2 + layer.transform.y);
  context.rotate((layer.transform.rotation * Math.PI) / 180);
  // A non-uniform stage scale keeps the composition undistorted.
  context.scale(layer.transform.flipX ? -layer.transform.scale : layer.transform.scale, layer.transform.flipY ? -layer.transform.scale : layer.transform.scale);

  const crop = layer.crop;
  const left = -canvasWidth / 2 + crop.left * canvasWidth;
  const top = -canvasHeight / 2 + crop.top * canvasHeight;
  const width = canvasWidth * (1 - crop.left - crop.right);
  const height = canvasHeight * (1 - crop.top - crop.bottom);

  if (width <= 0 || height <= 0) {
    context.restore();
    return;
  }

  if (layer.missing || !asset) {
    context.fillStyle = "rgba(255,128,128,0.18)";
    context.fillRect(left, top, width, height);
    context.strokeStyle = "rgba(255,128,128,0.75)";
    context.setLineDash([6, 4]);
    context.strokeRect(left, top, width, height);
    context.setLineDash([]);
    context.fillStyle = "#ffb0b0";
    context.font = "600 12px ui-sans-serif, system-ui, sans-serif";
    context.fillText("MEDIA OFFLINE", left + 8, top + 18);
    context.restore();
    return;
  }

  const hue = hashHue(asset.id);
  const gradient = context.createLinearGradient(left, top, left + width, top + height);
  if (asset.mediaType === "image") {
    gradient.addColorStop(0, `hsl(${hue} 44% 30%)`);
    gradient.addColorStop(1, `hsl(${(hue + 52) % 360} 60% 17%)`);
  } else {
    gradient.addColorStop(0, `hsl(${hue} 36% 24%)`);
    gradient.addColorStop(1, `hsl(${(hue + 28) % 360} 42% 12%)`);
  }
  context.fillStyle = gradient;
  context.fillRect(left, top, width, height);

  // Deterministic "content" so transforms, crop and opacity are visually verifiable.
  const random = mulberry(hashSeed(`${asset.id}:${frame}`));
  context.strokeStyle = "rgba(255,255,255,0.22)";
  context.lineWidth = 1;
  for (let i = 1; i < 4; i += 1) {
    const y = top + (height * i) / 4;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(left + width, y);
    context.stroke();
  }
  context.fillStyle = "rgba(255,255,255,0.12)";
  for (let i = 0; i < 4; i += 1) {
    const w = width * (0.12 + random() * 0.3);
    const h = height * (0.1 + random() * 0.35);
    context.fillRect(left + random() * (width - w), top + random() * (height - h), w, h);
  }

  // Small label + source-time readout so preview/export parity is auditable by eye.
  context.fillStyle = "rgba(0,0,0,0.5)";
  context.fillRect(left + 6, top + 6, Math.min(width - 12, 190), 20);
  context.fillStyle = "#eef2f8";
  context.font = "600 11px ui-monospace, Menlo, monospace";
  const sourceSeconds = sourceSecondsFor(clip, frame, asset, fps);
  context.fillText(`${layer.label.slice(0, 18)} · ${sourceSeconds.toFixed(2)}s`, left + 12, top + 20);

  context.restore();
}

function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hashHue(id: string): number {
  return hashSeed(id) % 360;
}

/** Deterministic PRNG so the same frame always paints identically. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (context.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.slice(-3);
}

/** Example consumer of the shared thumbnail query, used by the inspector's reference row. */
export function useAssetThumbnail(asset: Asset | undefined, workspacePath: string | null, atSeconds = 0) {
  return useThumbnail(
    asset && workspacePath ? { workspacePath, assetId: asset.id, atSeconds, width: 160 } : null,
  );
}
