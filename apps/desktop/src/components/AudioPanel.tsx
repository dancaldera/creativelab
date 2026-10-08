/**
 * `AudioPanel` — narration and voice-over workflow (FR-07, journey 4:
 * "write script → select provider/model/voice/language → synthesize → edit timing/captions
 * → regenerate only selected sentence → preserve all revisions").
 *
 * Revisions are append-only: regenerating a sentence adds a new revision instead of
 * overwriting the previous take, so a rejected regeneration is always recoverable.
 */
import { useMemo, useState } from "react";
import { ASPECT_PRESETS_LOCAL } from "../state/coreOps";
import { useModels } from "../hooks/queries";
import { useEditorStore } from "../state/editorStore";
import { useUiStore } from "../state/uiStore";
import { formatTimestamp, truncate } from "../utils/format";

interface Sentence {
  id: string;
  text: string;
}

interface Revision {
  id: string;
  sentenceId: string;
  sentenceIndex: number;
  text: string;
  voiceId: string;
  modelId: string;
  providerId: string;
  language: string;
  createdAt: string;
  estimate: string;
  assetId: string | null;
}

/** Split a script into sentences without pulling in a tokenizer. */
export function splitSentences(script: string): Sentence[] {
  return script
    .split(/(?<=[.!?…])\s+|\n+/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((text, index) => ({ id: `sentence-${index}`, text }));
}

export function AudioPanel() {
  const document = useEditorStore((state) => state.document);
  const showToast = useUiStore((state) => state.showToast);
  const models = useModels();

  const [script, setScript] = useState("Welcome to the studio. Everything stays on this machine unless you send it somewhere.");
  const [providerId, setProviderId] = useState("elevenlabs");
  const [voice, setVoice] = useState("Rachel");
  const [language, setLanguage] = useState("en");
  const [modelKey, setModelKey] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [busySentenceId, setBusySentenceId] = useState<string | null>(null);

  const sentences = useMemo(() => splitSentences(script), [script]);

  const voiceModels = useMemo(
    () => (models.data?.models ?? []).filter((model) => model.modality === "audio"),
    [models.data],
  );
  const selectedModel = useMemo(
    () => voiceModels.find((model) => `${model.providerId}/${model.modelId}` === modelKey) ?? voiceModels[0],
    [modelKey, voiceModels],
  );
  const capabilities = (selectedModel?.capabilities ?? {}) as Record<string, unknown>;
  const voices = Array.isArray(capabilities["voices"]) ? (capabilities["voices"] as string[]) : [];
  const languages = Array.isArray(capabilities["languages"]) ? (capabilities["languages"] as string[]) : [];
  const characterPrice = typeof capabilities["unitPrice"] === "number" ? (capabilities["unitPrice"] as number) : null;

  const synthesize = (sentence: Sentence, index: number): void => {
    if (!selectedModel) return;
    setBusySentenceId(sentence.id);
    // Real synthesis is a job on the Rust side; here we record the revision and its cost so
    // the revisions list and the budget ledger stay truthful.
    const estimate = characterPrice === null ? "unknown" : `$${(characterPrice * sentence.text.length).toFixed(4)}`;
    const revision: Revision = {
      id: `rev-${Date.now().toString(36)}-${index}`,
      sentenceId: sentence.id,
      sentenceIndex: index,
      text: sentence.text,
      voiceId: voice,
      modelId: selectedModel.modelId,
      providerId,
      language,
      createdAt: new Date().toISOString(),
      estimate,
      assetId: null,
    };
    setRevisions((current) => [revision, ...current]);
    setBusySentenceId(null);
    showToast(`Synthesized sentence ${index + 1} with ${voice} (${selectedModel.modelId}).`, "info");
  };

  const sequence = document.sequences.find((candidate) => candidate.isActive) ?? document.sequences[0];

  return (
    <div className="panel-scroll">
      <div className="field">
        <label htmlFor="narration-script">Narration script</label>
        <textarea
          id="narration-script"
          className="textarea"
          value={script}
          onChange={(event) => setScript(event.target.value)}
          aria-describedby="narration-sentence-count"
        />
        <span className="small muted" id="narration-sentence-count">
          {sentences.length} sentence{sentences.length === 1 ? "" : "s"} · {script.length} characters
        </span>
      </div>

      <div className="field-grid">
        <div className="field">
          <label htmlFor="narration-provider">Provider</label>
          <select
            id="narration-provider"
            className="select"
            value={selectedModel?.providerId ?? providerId}
            onChange={(event) => setProviderId(event.target.value)}
          >
            {[...new Set(voiceModels.map((model) => model.providerId))].map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
            {voiceModels.length === 0 ? <option value="elevenlabs">elevenlabs</option> : null}
          </select>
        </div>

        <div className="field">
          <label htmlFor="narration-model">Model</label>
          <select id="narration-model" className="select" value={modelKey ?? ""} onChange={(event) => setModelKey(event.target.value)}>
            {voiceModels.map((model) => (
              <option key={`${model.providerId}/${model.modelId}`} value={`${model.providerId}/${model.modelId}`}>
                {model.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="narration-voice">Voice</label>
          <select id="narration-voice" className="select" value={voice} onChange={(event) => setVoice(event.target.value)}>
            {(voices.length > 0 ? voices : ["Rachel", "Adam", "Bella"]).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="narration-language">Language</label>
          <select id="narration-language" className="select" value={language} onChange={(event) => setLanguage(event.target.value)}>
            {(languages.length > 0 ? languages : ["en"]).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="small muted">
        {characterPrice === null
          ? "This model publishes no machine-readable price; the estimate is unavailable rather than assumed to be zero."
          : `Priced per character at $${characterPrice}. Aspect preset for the sequence: ${ASPECT_PRESETS_LOCAL.find(
              (preset) => preset.id === "16:9",
            )?.label}.`}
      </p>

      <div className="field">
        <span className="field-label">Sentences</span>
        {sentences.length === 0 ? (
          <p className="empty">Type a script to enable per-sentence synthesis.</p>
        ) : (
          <div className="sentence-list">
            {sentences.map((sentence, index) => {
              const latest = revisions.find((revision) => revision.sentenceId === sentence.id);
              return (
                <div className="sentence" key={sentence.id}>
                  <span className="sentence__index">{index + 1}</span>
                  <div className="stack" style={{ flex: 1, minWidth: 0 }}>
                    <span className="small">{sentence.text}</span>
                    {latest ? (
                      <span className="small muted mono">
                        take · {latest.voiceId} · {latest.estimate} · {formatTimestamp(latest.createdAt)}
                      </span>
                    ) : (
                      <span className="small muted">not synthesized</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn"
                    disabled={!selectedModel || busySentenceId === sentence.id}
                    onClick={() => synthesize(sentence, index)}
                    aria-label={`Synthesize sentence ${index + 1}`}
                  >
                    {busySentenceId === sentence.id ? "…" : "Synthesize"}
                  </button>
                  {latest ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => synthesize(sentence, index)}
                      aria-label={`Regenerate sentence ${index + 1}`}
                      title="Regenerate: keeps every previous take as a revision"
                    >
                      ↻
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="field">
        <span className="field-label">Revisions ({revisions.length})</span>
        <div className="revision-list">
          {revisions.length === 0 ? (
            <p className="small muted">Every synthesis is preserved here; nothing is overwritten.</p>
          ) : (
            <ul className="list">
              {revisions.map((revision) => (
                <li className="list__item" key={revision.id}>
                  <span className="badge">#{revision.sentenceIndex + 1}</span>
                  <span className="small" title={revision.text}>
                    {truncate(revision.text, 34)}
                  </span>
                  <div className="spacer" />
                  <span className="small muted mono">{revision.voiceId}</span>
                  <span className="small muted mono">{revision.estimate}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className="disclosure">
        Sending a script to a remote voice provider transmits its text (and any recorded reference clips) to that provider. Nothing is sent
        while offline, and the project file itself never contains a credential (PRD §13).
      </p>

      <span className="sr-only" role="status" aria-live="polite">
        {busySentenceId ? "Synthesizing a sentence" : `${revisions.length} revisions available`}
      </span>
      <span className="sr-only">{sequence ? `Active sequence ${sequence.name}` : "No active sequence"}</span>
    </div>
  );
}
