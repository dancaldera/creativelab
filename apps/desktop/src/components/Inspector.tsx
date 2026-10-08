/**
 * `Inspector` — contextual properties for the selected clip (PRD §6 "Inspector:
 * position/scale/crop/opacity, blend where supported, audio gain/fades, in/out, speed,
 * transitions, effects and AI provenance").
 *
 * Every control writes through `setClipProperties`, i.e. through the undo stack. Slider
 * drags pass `coalesce: true` so one continuous drag is one undo step.
 *
 * Unsupported features are shown **disabled with a reason** rather than hidden silently
 * (PRD §8: "Unknown features must be hidden/disabled rather than silently ignored").
 */
import { useMemo } from "react";
import type { Clip } from "@creativelab/core";
import { clipEnd, framesToSeconds, sourceSpan } from "../state/coreOps";
import { useEditorStore, selectSelectedClip } from "../state/editorStore";
import { useJobsStore } from "../state/jobsStore";
import { formatMoney } from "../utils/money";
import { formatBytes, mediaTypeLabel } from "../utils/format";

export function Inspector() {
  const clip = useEditorStore(selectSelectedClip);
  const document = useEditorStore((state) => state.document);
  const selectionSize = useEditorStore((state) => state.selection.size);
  const setClipProperties = useEditorStore((state) => state.setClipProperties);
  const sequence =
    document.sequences.find((candidate) => candidate.isActive) ?? document.sequences[0];
  const fps = sequence?.fps ?? document.project.fps;

  const asset = useMemo(
    () =>
      clip?.assetId
        ? document.assets.find((candidate) => candidate.id === clip.assetId)
        : undefined,
    [clip?.assetId, document.assets],
  );
  const job = useJobsStore((state) =>
    asset?.generationJobId
      ? state.jobs.find((entry) => entry.id === asset.generationJobId)
      : undefined,
  );

  if (!clip) {
    return (
      <aside className="inspector" aria-label="Inspector">
        <header className="inspector__header">
          <h2 className="rail__panel-title">Inspector</h2>
        </header>
        <div className="inspector__sections">
          <p className="empty">
            {selectionSize > 1
              ? `${selectionSize} clips selected. Select exactly one clip to edit its properties.`
              : "Nothing selected. Click a clip to edit transform, crop, audio and AI provenance."}
          </p>
        </div>
      </aside>
    );
  }

  const update = (patch: Parameters<typeof setClipProperties>[1], coalesce = true) =>
    setClipProperties(clip.id, patch, { coalesce });
  const transform = clip.properties.transform;
  const crop = clip.properties.crop;
  const audio = clip.properties.audio;
  const speed = clip.properties.speed;

  return (
    <aside className="inspector" aria-label="Inspector">
      <header className="inspector__header">
        <h2 className="rail__panel-title" title={clip.label}>
          {clip.label || "Clip"}
        </h2>
        <span className="badge">{asset ? mediaTypeLabel(asset.mediaType) : "No media"}</span>
      </header>

      <div className="inspector__sections">
        <Section title="Timing" defaultOpen>
          <div className="provenance-grid">
            <dt>Start</dt>
            <dd className="mono">{clip.startFrame}f</dd>
            <dt>End</dt>
            <dd className="mono">{clipEnd(clip)}f</dd>
            <dt>Duration</dt>
            <dd className="mono">
              {clip.durationFrames}f ({framesToSeconds(clip.durationFrames, fps).toFixed(2)}s)
            </dd>
            <dt>Source in</dt>
            <dd className="mono">
              {clip.sourceInFrame}f / {sourceSpan(clip)}f span
            </dd>
            <dt>Asset frames</dt>
            <dd className="mono">{asset?.durationFrames ?? "unknown"}</dd>
            <dt>Version</dt>
            <dd className="mono">v{clip.version}</dd>
          </div>
          <div className="property-row property-row--wide">
            <label htmlFor={`speed-num-${clip.id}`}>Speed</label>
            <div className="row">
              <input
                id={`speed-num-${clip.id}`}
                type="number"
                min={1}
                max={16}
                value={speed.num}
                aria-label="Speed numerator"
                onChange={(event) =>
                  update({ speed: { num: Math.max(1, Number(event.target.value) || 1) } })
                }
              />
              <span className="muted">/</span>
              <input
                type="number"
                min={1}
                max={16}
                value={speed.den}
                aria-label="Speed denominator"
                onChange={(event) =>
                  update({ speed: { den: Math.max(1, Number(event.target.value) || 1) } })
                }
              />
              <span className="small muted">{(speed.num / speed.den).toFixed(2)}x</span>
            </div>
          </div>
        </Section>

        <Section title="Transform" defaultOpen>
          <NumberSlider
            id={`x-${clip.id}`}
            label="Position X"
            value={transform.x}
            min={-1920}
            max={1920}
            step={1}
            onChange={(value) => update({ transform: { x: value } })}
          />
          <NumberSlider
            id={`y-${clip.id}`}
            label="Position Y"
            value={transform.y}
            min={-1080}
            max={1080}
            step={1}
            onChange={(value) => update({ transform: { y: value } })}
          />
          <NumberSlider
            id={`scale-${clip.id}`}
            label="Scale"
            value={transform.scale}
            min={0.05}
            max={4}
            step={0.01}
            onChange={(value) => update({ transform: { scale: value } })}
          />
          <NumberSlider
            id={`rotation-${clip.id}`}
            label="Rotation"
            value={transform.rotation}
            min={-180}
            max={180}
            step={1}
            onChange={(value) => update({ transform: { rotation: value } })}
          />
          <NumberSlider
            id={`opacity-${clip.id}`}
            label="Opacity"
            value={transform.opacity}
            min={0}
            max={1}
            step={0.01}
            onChange={(value) => update({ transform: { opacity: value } })}
          />
          <div className="row">
            <button
              type="button"
              className="chip"
              aria-pressed={transform.flipX}
              onClick={() => update({ transform: { flipX: !transform.flipX } }, false)}
            >
              Flip horizontal
            </button>
            <button
              type="button"
              className="chip"
              aria-pressed={transform.flipY}
              onClick={() => update({ transform: { flipY: !transform.flipY } }, false)}
            >
              Flip vertical
            </button>
          </div>
        </Section>

        <Section title="Crop">
          <p className="small muted">
            Crop is stored as a fraction of the source, so it survives a proxy swap (PRD §12).
          </p>
          {(["top", "right", "bottom", "left"] as const).map((edge) => (
            <NumberSlider
              key={edge}
              id={`crop-${edge}-${clip.id}`}
              label={edge}
              value={crop[edge]}
              min={0}
              max={0.9}
              step={0.01}
              onChange={(value) => update({ crop: { [edge]: value } as Partial<typeof crop> })}
            />
          ))}
        </Section>

        <Section title="Audio">
          <label className="row small">
            <input
              type="checkbox"
              checked={audio.enabled}
              onChange={(event) => update({ audio: { enabled: event.target.checked } }, false)}
            />
            Include this clip&apos;s audio in the mix
          </label>
          <NumberSlider
            id={`gain-${clip.id}`}
            label="Gain (dB)"
            value={audio.gainDb}
            min={-60}
            max={12}
            step={0.5}
            onChange={(value) => update({ audio: { gainDb: value } })}
          />
          <NumberSlider
            id={`fadein-${clip.id}`}
            label="Fade in (f)"
            value={audio.fadeInFrames}
            min={0}
            max={Math.max(1, clip.durationFrames)}
            step={1}
            onChange={(value) => update({ audio: { fadeInFrames: Math.round(value) } })}
          />
          <NumberSlider
            id={`fadeout-${clip.id}`}
            label="Fade out (f)"
            value={audio.fadeOutFrames}
            min={0}
            max={Math.max(1, clip.durationFrames)}
            step={1}
            onChange={(value) => update({ audio: { fadeOutFrames: Math.round(value) } })}
          />
          <NumberSlider
            id={`pan-${clip.id}`}
            label="Pan"
            value={audio.pan}
            min={-1}
            max={1}
            step={0.02}
            onChange={(value) => update({ audio: { pan: value } })}
          />
        </Section>

        <Section title="Transitions">
          {(["transitionIn", "transitionOut"] as const).map((key) => (
            <div className="row" key={key}>
              <label className="small muted" htmlFor={`${key}-${clip.id}`}>
                {key === "transitionIn" ? "In" : "Out"}
              </label>
              <select
                id={`${key}-${clip.id}`}
                className="select"
                value={clip.properties[key].kind}
                onChange={(event) =>
                  update({ [key]: { kind: event.target.value as never } }, false)
                }
              >
                {TRANSITION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={0}
                max={Math.max(1, clip.durationFrames)}
                value={clip.properties[key].durationFrames}
                aria-label={`${key === "transitionIn" ? "In" : "Out"} transition duration in frames`}
                onChange={(event) =>
                  update(
                    { [key]: { durationFrames: Math.max(0, Number(event.target.value) || 0) } },
                    false,
                  )
                }
                style={{ width: 72 }}
              />
            </div>
          ))}
        </Section>

        <Section title="Effects">
          {/*
            PRD §8: "Unknown features must be hidden/disabled rather than silently ignored."
            `packages/media/src/graph.ts` — the function that turns this timeline into the
            FFmpeg filter graph — reads `clip`, `track` and `asset` only; it never touches
            `document.effects` or `document.keyframes`. So an entry listed here is stored
            data with no effect on the pixels, and saying so plainly is required.
          */}
          <p className="callout callout--warning" role="note">
            <strong>Clip effects and keyframes are not applied by the renderer yet.</strong> They
            are stored in the project and listed below for reference only: the preview and the
            export graph ignore <code className="mono">effects</code> and{" "}
            <code className="mono">keyframes</code> entirely today (FR-12 / Phase 4, tracked as an
            issue). Until that lands, adding one would change nothing on screen or in the exported
            file.
          </p>
          {document.effects.filter((effect) => effect.clipId === clip.id).length === 0 ? (
            <p className="small muted">No effects are recorded on this clip.</p>
          ) : (
            <>
              <ul className="list">
                {document.effects
                  .filter((effect) => effect.clipId === clip.id)
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((effect) => (
                    <li className="list__item" key={effect.id}>
                      <span>{effect.kind}</span>
                      <div className="spacer" />
                      <span className="small muted mono">{JSON.stringify(effect.params)}</span>
                      <span className="badge">{effect.enabled ? "on" : "off"}</span>
                      <span
                        className="badge badge--warning"
                        title="Stored, but not applied by preview or export"
                      >
                        inert
                      </span>
                    </li>
                  ))}
              </ul>
              <p className="small muted">
                These{" "}
                {document.effects.filter((effect) => effect.clipId === clip.id).length === 1
                  ? "entries were"
                  : "entries were"}{" "}
                loaded with the project (an importer, a template, or a future build) and are
                preserved on save so nothing is lost — they simply do not render yet.
              </p>
            </>
          )}
          <div className="row">
            <button
              type="button"
              className="btn"
              disabled
              aria-disabled="true"
              title="Authoring is disabled while the export graph ignores effects (FR-12 / Phase 4)"
            >
              Add effect…
            </button>
            <span className="small muted">
              Disabled on purpose: this build cannot apply what it would author.
            </span>
          </div>
          <p className="unsupported">
            Editing effect parameters and authoring keyframes arrive with FR-12. Adding an authoring
            control before the render graph consumes it would let the UI accept work the renderer
            silently drops.
          </p>
        </Section>

        <Section title="Blend mode">
          <p className="unsupported">
            Blend modes are marked unsupported in this build. The schema has no blend field yet, and
            the render graph would need an explicit compositor pass; showing a control that silently
            did nothing would violate PRD §8.
          </p>
        </Section>

        <Section title="AI provenance" defaultOpen>
          {asset?.origin === "generated" || asset?.generationJobId ? (
            <>
              <dl className="provenance-grid">
                <dt>Model</dt>
                <dd className="mono">{job ? `${job.providerId} / ${job.modelId}` : "—"}</dd>
                <dt>Mode</dt>
                <dd className="mono">{job?.mode ?? asset?.probe?.["mode"]?.toString() ?? "—"}</dd>
                <dt>Job state</dt>
                <dd>
                  {job ? (
                    <span
                      className={`badge ${job.status === "failed" ? "badge--danger" : job.status === "completed" ? "badge--success" : ""}`}
                    >
                      {job.status}
                    </span>
                  ) : (
                    <span className="badge">unknown</span>
                  )}
                </dd>
                <dt>Job id</dt>
                <dd className="mono">{asset?.generationJobId ?? "—"}</dd>
                <dt>Seed</dt>
                <dd className="mono">{readProbeNumber(asset?.probe, "seed") ?? "—"}</dd>
                <dt>Prompt revision</dt>
                <dd className="mono">{asset?.promptRevisionId ?? "—"}</dd>
                <dt>Estimate</dt>
                <dd className="mono">{job?.costEstimate ? formatMoney(job.costEstimate) : "—"}</dd>
                <dt>Actual cost</dt>
                <dd className="mono">{job?.actualCost ? formatMoney(job.actualCost) : "—"}</dd>
                <dt>Origin</dt>
                <dd className="mono">
                  {asset?.origin} · {asset?.storageMode}
                </dd>
                <dt>Bytes</dt>
                <dd className="mono">{formatBytes(asset?.bytes)}</dd>
                <dt>Parent</dt>
                <dd className="mono">{asset?.parentAssetId ?? "—"}</dd>
              </dl>
              <p className="provenance-prompt">
                {readProbeString(asset?.probe, "prompt") ??
                  "No prompt was recorded for this asset."}
              </p>
            </>
          ) : (
            <p className="small muted">
              This clip references imported media, so it has no generation provenance. Imported
              assets keep their original path and checksum instead.
            </p>
          )}
        </Section>
      </div>
    </aside>
  );
}

const TRANSITION_KINDS = [
  "none",
  "crossfade",
  "dip-to-black",
  "dip-to-white",
  "slide-left",
  "slide-right",
  "wipe-left",
  "wipe-right",
  "zoom-in",
  "zoom-out",
] as const;

function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="section" open={defaultOpen}>
      <summary className="section__header">{title}</summary>
      <div className="section__body">{children}</div>
    </details>
  );
}

interface NumberSliderProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

/**
 * Paired range + number input. Both are labelled, and the number field is what a
 * keyboard-only user reaches for exact values with.
 */
function NumberSlider({ id, label, value, min, max, step, onChange }: NumberSliderProps) {
  return (
    <div className="property-row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuenow={value}
        aria-valuetext={`${label} ${Number(value.toFixed(3))}`}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number(value.toFixed(3))}
        aria-label={`${label} exact value`}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function readProbeString(
  probe: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = probe?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readProbeNumber(
  probe: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  const value = probe?.[key];
  return typeof value === "number" ? value : null;
}

/** Re-exported for panels that need the same money formatting as the inspector. */
export { formatMoney };

/** Narrow helper used by tests and by the storyboard converter. */
export function clipSummary(clip: Clip): string {
  return `${clip.label || "Clip"} · ${clip.startFrame}–${clipEnd(clip)}f · src ${clip.sourceInFrame}`;
}
