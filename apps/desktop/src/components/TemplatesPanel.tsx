/**
 * `TemplatesPanel` — reusable scenes/looks (FR-12: "reusable templates").
 *
 * Templates are described declaratively and materialised as *ordinary clips*: applying one
 * creates tracks/clips through the same pure timeline algebra as any manual edit, so nothing
 * is flattened, merged or baked (the same rule the storyboard converter follows).
 */
import { useMemo, useState } from "react";
import type { Clip } from "@creativelab/core";
import { ASPECT_PRESETS_LOCAL } from "../state/coreOps";
import { createClip } from "../state/clipFactory";
import { useEditorStore } from "../state/editorStore";
import { useUiStore } from "../state/uiStore";

interface TemplateShot {
  label: string;
  durationSeconds: number;
  prompt: string;
  kind: "video" | "audio" | "caption";
}

interface Template {
  id: string;
  title: string;
  description: string;
  aspect: string;
  fpsId: string;
  shots: TemplateShot[];
}

export const BUILT_IN_TEMPLATES: readonly Template[] = [
  {
    id: "reel-9x16",
    title: "Vertical reel",
    description: "Hook, three beats and a call to action, cut for 9:16.",
    aspect: "9:16",
    fpsId: "30",
    shots: [
      {
        label: "Hook",
        durationSeconds: 2.5,
        prompt: "Bold opening shot, subject centred, shallow depth of field",
        kind: "video",
      },
      {
        label: "Beat 1",
        durationSeconds: 3,
        prompt: "Product close-up with slow push in",
        kind: "video",
      },
      {
        label: "Beat 2",
        durationSeconds: 3,
        prompt: "Use-case in context, natural light",
        kind: "video",
      },
      { label: "Beat 3", durationSeconds: 3, prompt: "Detail texture shot", kind: "video" },
      {
        label: "Call to action",
        durationSeconds: 2.5,
        prompt: "Clean end card with room for a title",
        kind: "video",
      },
      {
        label: "Music bed",
        durationSeconds: 14,
        prompt: "Uplifting electronic bed, 120 bpm",
        kind: "audio",
      },
    ],
  },
  {
    id: "explainer-16x9",
    title: "Explainer",
    description: "Narration-led landscape explainer with captions.",
    aspect: "16:9",
    fpsId: "30",
    shots: [
      {
        label: "Title",
        durationSeconds: 3,
        prompt: "Minimal title card over a soft gradient",
        kind: "video",
      },
      {
        label: "Problem",
        durationSeconds: 5,
        prompt: "Illustrative b-roll of the workflow being slow",
        kind: "video",
      },
      {
        label: "Solution",
        durationSeconds: 6,
        prompt: "Screen recording style shot of the editor",
        kind: "video",
      },
      { label: "Proof", durationSeconds: 5, prompt: "Before and after split frame", kind: "video" },
      { label: "Outro", durationSeconds: 3, prompt: "Logo on a clean background", kind: "video" },
      { label: "Narration", durationSeconds: 22, prompt: "Calm, clear narration", kind: "audio" },
      {
        label: "Captions",
        durationSeconds: 22,
        prompt: "Auto-aligned caption track",
        kind: "caption",
      },
    ],
  },
  {
    id: "square-promo",
    title: "Square promo",
    description: "Three-shot 1:1 promo for social feeds.",
    aspect: "1:1",
    fpsId: "25",
    shots: [
      {
        label: "Open",
        durationSeconds: 3,
        prompt: "Bold graphic opening, high contrast",
        kind: "video",
      },
      { label: "Show", durationSeconds: 4, prompt: "Product in use, tight framing", kind: "video" },
      {
        label: "Close",
        durationSeconds: 3,
        prompt: "End card with generous negative space",
        kind: "video",
      },
    ],
  },
] as const;

export function TemplatesPanel() {
  const applyEdit = useEditorStore((state) => state.applyEdit);
  const showToast = useUiStore((state) => state.showToast);
  const document = useEditorStore((state) => state.document);
  const [applied, setApplied] = useState<string[]>([]);

  const projectFps =
    document.sequences.find((sequence) => sequence.isActive)?.fps ?? document.project.fps;

  const templates = useMemo(() => BUILT_IN_TEMPLATES, []);

  const applyTemplate = (template: Template): void => {
    const framesPerSecond = projectFps.num / projectFps.den;
    applyEdit(`Apply template: ${template.title}`, (current) => {
      const sequence = current.sequences.find((entry) => entry.isActive) ?? current.sequences[0];
      if (!sequence) return current;
      const now = new Date().toISOString();
      const newClips: Clip[] = [];
      const cursors: Record<"video" | "audio" | "caption", number> = {
        video: 0,
        audio: 0,
        caption: 0,
      };

      for (const shot of template.shots) {
        const track = current.tracks
          .filter((candidate) => candidate.kind === shot.kind && !candidate.locked)
          .sort((a, b) => a.sortOrder - b.sortOrder)[0];
        if (!track) continue;
        const durationFrames = Math.max(1, Math.round(shot.durationSeconds * framesPerSecond));
        const start = cursors[shot.kind];
        cursors[shot.kind] = start + durationFrames;
        newClips.push(
          createClip(
            {
              trackId: track.id,
              sequenceId: sequence.id,
              label: shot.label,
              notes: shot.prompt,
              startFrame: start,
              durationFrames,
            },
            now,
          ),
        );
      }

      return {
        ...current,
        project: {
          ...current.project,
          width:
            ASPECT_PRESETS_LOCAL.find((preset) => preset.id === template.aspect)?.width ??
            current.project.width,
          height:
            ASPECT_PRESETS_LOCAL.find((preset) => preset.id === template.aspect)?.height ??
            current.project.height,
          updatedAt: now,
        },
        clips: [...current.clips, ...newClips],
      };
    });
    setApplied((current) => [...new Set([...current, template.id])]);
    showToast(
      `Applied “${template.title}”: ${template.shots.length} placeholder clips (editable, nothing baked).`,
      "info",
    );
  };

  return (
    <div className="panel-scroll">
      <p className="small muted">
        Templates create ordinary tracks and clips. They never flatten, merge or bake media, so
        every placeholder stays editable and can be replaced with an import or a generation result.
      </p>

      {templates.map((template) => (
        <article className="template-card" key={template.id}>
          <header className="row row--between">
            <span className="template-card__title">{template.title}</span>
            <span className="badge">
              {template.aspect} · {template.shots.length} shots
            </span>
          </header>
          <div className="template-card__thumb" aria-hidden="true">
            {template.shots
              .filter((shot) => shot.kind === "video")
              .map((shot) => (
                <span
                  key={shot.label}
                  className="template-card__shot"
                  style={{ flex: Math.max(1, Math.round(shot.durationSeconds * 4)) }}
                  title={`${shot.label} · ${shot.durationSeconds}s`}
                />
              ))}
          </div>
          <p className="small muted">{template.description}</p>
          <details>
            <summary className="small muted">Shot list</summary>
            <ul className="list" style={{ marginTop: 6 }}>
              {template.shots.map((shot) => (
                <li className="list__item" key={`${template.id}-${shot.label}`}>
                  <span className="badge">{shot.kind}</span>
                  <span>{shot.label}</span>
                  <div className="spacer" />
                  <span className="small muted mono">{shot.durationSeconds}s</span>
                </li>
              ))}
            </ul>
          </details>
          <div className="row">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => applyTemplate(template)}
            >
              {applied.includes(template.id) ? "Apply again" : "Apply to timeline"}
            </button>
            {applied.includes(template.id) ? (
              <span className="badge badge--success">applied</span>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}
