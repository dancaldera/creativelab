/**
 * `GeneratePanel` — AI generation surface (FR-05/06/07, PRD §6 "Generation panel").
 *
 * Safety and money rules baked into the flow (PRD §13, §12):
 *   1. The **negative prompt is only rendered when the selected model advertises
 *      `supportsNegativePrompt`** — an unsupported feature is hidden, never silently sent.
 *   2. The estimated cost is computed before submit and passed through `evaluateBudget`.
 *      A blocked budget disables Generate; an above-threshold cost requires a second,
 *      explicit confirmation; unknown pricing is called out as unknown rather than $0.
 *   3. Before anything is submitted to a remote provider, a **transfer disclosure** lists
 *      exactly which files leave the device.
 */
import { useMemo, useState } from "react";
import type { JobDto, ProviderModelDto } from "../bridge/protocol";
import { getBridge } from "../bridge";
import { evaluateBudget } from "../state/budgetOps";
import { useModels, useRefreshCatalog } from "../hooks/queries";
import { useEditorStore } from "../state/editorStore";
import { useJobsStore } from "../state/jobsStore";
import { useUiStore } from "../state/uiStore";
import { DEFAULT_BUDGET_POLICY_LOCAL } from "../state/coreOps";
import { formatMoney, roundMoney } from "../utils/money";
import { formatTimestamp, truncate } from "../utils/format";

type Modality = "image" | "video" | "audio" | "subtitle";

const MODALITIES: ReadonlyArray<{ id: Modality; label: string }> = [
  { id: "image", label: "Image" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "subtitle", label: "Transcribe" },
];

export function GeneratePanel() {
  const document = useEditorStore((state) => state.document);
  const workspacePath = useEditorStore((state) => state.workspacePath);
  const playheadFrame = useEditorStore((state) => state.playheadFrame);
  const showToast = useUiStore((state) => state.showToast);
  const models = useModels();
  const refreshCatalog = useRefreshCatalog();
  const recordCost = useJobsStore((state) => state.recordCost);
  const spendToday = useJobsStore((state) => state.spendToday);
  const jobs = useJobsStore((state) => state.jobs);

  const [modality, setModality] = useState<Modality>("image");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [modelKey, setModelKey] = useState<string | null>(null);
  const [aspect, setAspect] = useState("16:9");
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [seed, setSeed] = useState("");
  const [quality, setQuality] = useState("standard");
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [approvedCost, setApprovedCost] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const candidates = useMemo(
    () => (models.data?.models ?? []).filter((model) => model.modality === modality),
    [modality, models.data],
  );

  const selected: ProviderModelDto | undefined = useMemo(
    () =>
      candidates.find((model) => `${model.providerId}/${model.modelId}` === modelKey) ??
      candidates[0],
    [candidates, modelKey],
  );

  const capabilities = (selected?.capabilities ?? {}) as Record<string, unknown>;
  const supportsNegative = capabilities["supportsNegativePrompt"] === true;
  const supportsSeed = capabilities["supportsSeed"] === true;
  const referenceMode =
    typeof capabilities["referenceFrame"] === "string"
      ? (capabilities["referenceFrame"] as string)
      : "none";
  const aspectOptions = Array.isArray(capabilities["aspectRatios"])
    ? (capabilities["aspectRatios"] as string[])
    : [];
  const durationMin =
    typeof capabilities["durationMinSeconds"] === "number"
      ? (capabilities["durationMinSeconds"] as number)
      : null;
  const durationMax =
    typeof capabilities["durationMaxSeconds"] === "number"
      ? (capabilities["durationMaxSeconds"] as number)
      : null;

  const estimate = useMemo(() => {
    if (!selected) return null;
    const unitPrice =
      typeof capabilities["unitPrice"] === "number" ? (capabilities["unitPrice"] as number) : null;
    if (unitPrice === null) return null;
    const unit =
      typeof (capabilities["pricing"] as Record<string, unknown> | null)?.["unit"] === "string"
        ? String((capabilities["pricing"] as Record<string, unknown>)["unit"])
        : "job";
    let amount = unitPrice;
    if (unit === "second") amount = unitPrice * durationSeconds;
    else if (unit === "character") amount = unitPrice * Math.max(1, prompt.length);
    return { amount: roundMoney(amount), currency: "USD", unit, isEstimate: true as const };
  }, [capabilities, durationSeconds, prompt.length, selected]);

  const policy = DEFAULT_BUDGET_POLICY_LOCAL;
  const todaySpend = spendToday(policy.currency);
  const decision = evaluateBudget(policy, estimate, todaySpend);
  const needsApproval =
    decision.allowed && decision.requiresApproval && approvedCost !== estimate?.amount;

  const transferFiles = useMemo(() => {
    const referenced = referenceIds
      .map((id) => document.assets.find((asset) => asset.id === id))
      .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
    return referenced.map((asset) => ({
      id: asset.id,
      label: asset.relativePath ?? asset.uri,
      bytes: asset.bytes ?? 0,
      remote: true,
    }));
  }, [document.assets, referenceIds]);

  const jobHistory = useMemo(
    () => jobs.filter((job) => job.modality === modality).slice(0, 6),
    [jobs, modality],
  );

  const runGenerate = async () => {
    if (!selected) return;
    if (!decision.allowed) return;
    setSubmitting(true);
    try {
      // The mock bridge has no generation command in the frozen protocol, so this records a
      // local job row and spends against the ledger — exactly the bookkeeping the real
      // pipeline performs before the provider is contacted.
      const job = recordGeneratedJob({
        providerId: selected.providerId,
        modelId: selected.modelId,
        modality,
        prompt,
        negativePrompt: supportsNegative ? negativePrompt : null,
        seed: supportsSeed && seed.trim() ? Number(seed) : null,
        durationSeconds,
        aspect,
        quality,
        references: referenceIds,
        estimate,
      });
      if (estimate) {
        recordCost({
          jobId: job.id,
          amount: estimate.amount,
          currency: estimate.currency,
          day: new Date().toISOString().slice(0, 10),
          kind: "estimate",
        });
      }
      setApprovedCost(null);
      showToast(
        `Queued ${modality} job on ${selected.providerId}/${selected.modelId}${
          estimate ? ` · estimated ${formatMoney(estimate)}` : " · pricing unknown"
        }.`,
        "info",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="panel-scroll">
      <div className="modality-tabs" role="tablist" aria-label="Modality">
        {MODALITIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            className="modality-tab"
            aria-selected={modality === entry.id}
            onClick={() => {
              setModality(entry.id);
              setModelKey(null);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="field">
        <label htmlFor="generate-prompt">Prompt</label>
        <textarea
          id="generate-prompt"
          className="textarea"
          value={prompt}
          placeholder={
            modality === "audio"
              ? "Describe the sound or write the line to speak…"
              : "Describe the shot…"
          }
          onChange={(event) => setPrompt(event.target.value)}
        />
      </div>

      {supportsNegative ? (
        <div className="field">
          <label htmlFor="generate-negative">Negative prompt</label>
          <textarea
            id="generate-negative"
            className="textarea"
            style={{ minHeight: 52 }}
            value={negativePrompt}
            placeholder="What to avoid…"
            onChange={(event) => setNegativePrompt(event.target.value)}
          />
        </div>
      ) : (
        <p className="unsupported">
          This model does not support negative prompts, so the field is hidden rather than silently
          ignored (PRD §8).
        </p>
      )}

      <div className="field">
        <span className="field-label">Compatible models</span>
        {models.isLoading ? <p className="small muted">Loading model catalog…</p> : null}
        {models.isError ? (
          <p className="small" style={{ color: "var(--danger)" }}>
            Could not load the catalog.
          </p>
        ) : null}
        {!models.isLoading && candidates.length === 0 ? (
          <p className="empty">No model in the catalog advertises the {modality} modality.</p>
        ) : null}
        <div className="model-list">
          {candidates.map((model) => {
            const key = `${model.providerId}/${model.modelId}`;
            const caps = model.capabilities as Record<string, unknown>;
            const price =
              typeof caps["unitPrice"] === "number" ? (caps["unitPrice"] as number) : null;
            const unit =
              typeof (caps["pricing"] as Record<string, unknown> | null)?.["unit"] === "string"
                ? String((caps["pricing"] as Record<string, unknown>)["unit"])
                : "job";
            return (
              <button
                key={key}
                type="button"
                className="model-option"
                aria-pressed={
                  selected ? key === `${selected.providerId}/${selected.modelId}` : false
                }
                onClick={() => setModelKey(key)}
              >
                <span className="model-option__name">{model.displayName}</span>
                <span className="model-option__meta">
                  {model.providerId} · {price === null ? "price unknown" : `${price} / ${unit}`}
                  {model.isStale ? " · stale" : ""}
                </span>
              </button>
            );
          })}
        </div>
        <div className="row">
          <span className="small muted">
            Catalog fetched {formatTimestamp(models.data?.fetchedAt)}
          </span>
          <div className="spacer" />
          <button
            type="button"
            className="chip"
            disabled={refreshCatalog.isPending}
            onClick={() => void refreshCatalog.mutateAsync(undefined)}
          >
            {refreshCatalog.isPending ? "refreshing…" : "refresh"}
          </button>
        </div>
      </div>

      <div className="field-grid">
        <div className="field">
          <label htmlFor="generate-aspect">Aspect</label>
          <select
            id="generate-aspect"
            className="select"
            value={aspect}
            disabled={aspectOptions.length === 0}
            onChange={(event) => setAspect(event.target.value)}
          >
            {(aspectOptions.length > 0 ? aspectOptions : [aspect]).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="generate-duration">
            Duration (s)
            {durationMin !== null && durationMax !== null ? ` ${durationMin}–${durationMax}` : ""}
          </label>
          <input
            id="generate-duration"
            className="input"
            type="number"
            min={durationMin ?? 1}
            max={durationMax ?? 60}
            value={durationSeconds}
            disabled={durationMin === null && durationMax === null}
            onChange={(event) => setDurationSeconds(Number(event.target.value) || 1)}
          />
        </div>

        <div className="field">
          <label htmlFor="generate-seed">Seed</label>
          <input
            id="generate-seed"
            className="input"
            value={seed}
            placeholder={supportsSeed ? "random" : "unsupported"}
            disabled={!supportsSeed}
            onChange={(event) => setSeed(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="generate-quality">Quality</label>
          <select
            id="generate-quality"
            className="select"
            value={quality}
            onChange={(event) => setQuality(event.target.value)}
          >
            {["draft", "standard", "high"].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <span className="field-label">
          References ({referenceMode === "none" ? "unsupported by this model" : referenceMode})
        </span>
        <div className="reference-list">
          {document.assets
            .filter((asset) => asset.mediaType === "image" || asset.mediaType === "video")
            .slice(0, 8)
            .map((asset) => {
              const active = referenceIds.includes(asset.id);
              return (
                <button
                  key={asset.id}
                  type="button"
                  className="reference-chip"
                  aria-pressed={active}
                  disabled={referenceMode === "none"}
                  title={asset.relativePath ?? asset.uri}
                  onClick={() =>
                    setReferenceIds((current) =>
                      active ? current.filter((id) => id !== asset.id) : [...current, asset.id],
                    )
                  }
                >
                  {truncate(asset.relativePath?.split("/").pop() ?? asset.id, 18)}
                </button>
              );
            })}
          {document.assets.length === 0 ? (
            <span className="small muted">
              Import or generate an asset to use it as a reference.
            </span>
          ) : null}
        </div>
      </div>

      {/* Cost estimate + budget gate ------------------------------------- */}
      <div className="cost-row">
        <span>Estimated cost</span>
        <span className="cost-row__amount">
          {estimate ? (
            formatMoney(estimate)
          ) : (
            <span title="The provider publishes no machine-readable pricing">unknown</span>
          )}
        </span>
      </div>
      <p className="small muted">
        Today: {formatMoney({ amount: todaySpend, currency: policy.currency })} · per-job cap{" "}
        {policy.maxCostPerJob === null
          ? "none"
          : formatMoney({ amount: policy.maxCostPerJob, currency: policy.currency })}{" "}
        · daily ceiling{" "}
        {policy.dailyCeiling === null
          ? "none"
          : formatMoney({ amount: policy.dailyCeiling, currency: policy.currency })}
      </p>

      {!decision.allowed ? (
        <p className="callout callout--danger" role="alert">
          Budget blocked ({decision.code}): {decision.reason}
        </p>
      ) : decision.requiresApproval ? (
        <p className="callout callout--warning" role="alert">
          {decision.reason}
        </p>
      ) : (
        <p className="callout callout--info">Within budget.</p>
      )}

      {/* Transfer disclosure: exactly which files leave this device ---------- */}
      <div className="disclosure">
        <strong>Which files leave this device</strong>
        <ul>
          <li>
            Prompt text{negativePrompt && supportsNegative ? ", the negative prompt" : ""} and
            generation parameters are sent to{" "}
            <code>
              {selected ? `${selected.providerId} (${selected.modelId})` : "the selected provider"}
            </code>
            .
          </li>
          {transferFiles.length === 0 ? (
            <li>No media files are uploaded: no references are attached to this request.</li>
          ) : (
            transferFiles.map((file) => (
              <li key={file.id}>
                Reference <code>{file.label}</code> is uploaded to the provider.
              </li>
            ))
          )}
          <li>
            The provider may retain inputs and outputs under its own policy; local editing and
            export never transmit media. Nothing is transmitted while you are offline.
          </li>
        </ul>
      </div>

      <div className="row">
        <button
          type="button"
          className="btn btn--primary"
          disabled={
            !selected ||
            !decision.allowed ||
            prompt.trim().length === 0 ||
            submitting ||
            needsApproval
          }
          onClick={() => void runGenerate()}
        >
          {submitting ? "Submitting…" : "Generate"}
        </button>
        {needsApproval && estimate ? (
          <button type="button" className="btn" onClick={() => setApprovedCost(estimate.amount)}>
            Approve {formatMoney(estimate)}
          </button>
        ) : null}
        <div className="spacer" />
        <span className="small muted">
          {workspacePath ? "workspace ready" : "no workspace"} · frame {playheadFrame}
        </span>
      </div>

      <div className="field">
        <span className="field-label">Job history ({modality})</span>
        {jobHistory.length === 0 ? (
          <p className="small muted">No {modality} jobs in this session yet.</p>
        ) : (
          <ul className="list">
            {jobHistory.map((job) => (
              <li className="list__item" key={job.id}>
                <span className="badge">{job.status}</span>
                <span className="mono small">{job.modelId}</span>
                <div className="spacer" />
                <span className="small muted mono">
                  {job.costEstimate ? formatMoney(job.costEstimate) : "—"}
                </span>
                <span className="small muted">{formatTimestamp(job.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface RecordedJobInput {
  providerId: string;
  modelId: string;
  modality: Modality;
  prompt: string;
  negativePrompt: string | null;
  seed: number | null;
  durationSeconds: number;
  aspect: string;
  quality: string;
  references: string[];
  estimate: { amount: number; currency: string; unit: string; isEstimate: true } | null;
}

/**
 * Record the job locally.
 *
 * The frozen `StudioBridge` has no `generate` command — generation is expressed through the
 * job queue (`job_list`/`job_cancel`/`job_retry`/`job_reconcile`), which the Rust half owns.
 * The mock therefore fabricates the queue row here so the panel, the budget ledger and the
 * jobs panel all have real data to show.
 */
function recordGeneratedJob(input: RecordedJobInput): { id: string } {
  const bridge = getBridge();
  const now = new Date().toISOString();
  const id = `job_${Math.random().toString(16).slice(2, 26)}`;
  const job: JobDto = {
    id,
    providerId: input.providerId,
    modelId: input.modelId,
    mode: modeFor(input.modality),
    modality: input.modality,
    status: "queued",
    progress: 0,
    providerJobId: null,
    retryCount: 0,
    costEstimate: input.estimate
      ? { amount: input.estimate.amount, currency: input.estimate.currency }
      : null,
    actualCost: null,
    outputAssetIds: [],
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  useJobsStore.getState().upsertJob(job);
  // The mock keeps its own job table so a later `job_list` poll does not lose the row; the
  // Tauri bridge has no such affordance and is simply skipped.
  const seeding = bridge as { seedJob?: (job: JobDto) => unknown };
  if (typeof seeding.seedJob === "function") seeding.seedJob(job);
  return { id };
}

function modeFor(modality: Modality): string {
  switch (modality) {
    case "image":
      return "text-to-image";
    case "video":
      return "text-to-video";
    case "audio":
      return "tts";
    case "subtitle":
      return "transcription";
    default:
      return "unknown";
  }
}
