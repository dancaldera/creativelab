/**
 * `SettingsDialog` — provider credentials, model catalog, budget policy, storage and
 * accessibility (FR-08, PRD §6/§13/§14).
 *
 * ## The credential rule
 *
 * Secret fields are **write-only**. The dialog renders `hasSecret` as a badge and never asks
 * for, stores, logs or displays a key: `credentialSet` sends the value one way, and
 * `credentialList` returns only `{ credentialRef, hasSecret }`. The field is cleared
 * immediately after a successful save, and the value never reaches a query cache, a log line
 * or an error message.
 */
import { useState } from "react";
import { getBridge } from "../bridge";
import { useCredentials, useDeleteCredential, useModels, useRefreshCatalog, useSetCredential, useTestCredential } from "../hooks/queries";
import { useEditorStore } from "../state/editorStore";
import { useUiStore } from "../state/uiStore";
import { DEFAULT_BUDGET_POLICY_LOCAL } from "../state/coreOps";
import { UI_SETTINGS_KEY } from "../state/uiStore";
import { formatBytes, formatRelative, formatTimestamp } from "../utils/format";
import { formatMoney } from "../utils/money";

const PROVIDERS = [
  { id: "vercel-gateway", label: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh" },
  { id: "elevenlabs", label: "ElevenLabs (direct)", baseUrl: "https://api.elevenlabs.io" },
  { id: "cloudflare-ai", label: "Cloudflare Workers AI", baseUrl: "https://api.cloudflare.com/client/v4" },
] as const;

type Tab = "providers" | "models" | "budget" | "storage" | "accessibility";

export function SettingsDialog() {
  const settingsOpen = useUiStore((state) => state.settingsOpen);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const reducedMotion = useUiStore((state) => state.reducedMotion);
  const setReducedMotion = useUiStore((state) => state.setReducedMotion);
  const showToast = useUiStore((state) => state.showToast);
  const workspacePath = useEditorStore((state) => state.workspacePath);
  const snapshot = useUiStore((state) => state.snapshot);

  const credentials = useCredentials();
  const models = useModels();
  const setCredential = useSetCredential();
  const deleteCredential = useDeleteCredential();
  const testCredential = useTestCredential();
  const refreshCatalog = useRefreshCatalog();

  const [tab, setTab] = useState<Tab>("providers");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>(
    Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider.baseUrl])),
  );
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [staleDays, setStaleDays] = useState(14);
  const [policy, setPolicy] = useState(DEFAULT_BUDGET_POLICY_LOCAL);
  const [storage, setStorage] = useState<{ bytes: number; reclaimable: number } | null>(null);

  // Every hook above runs unconditionally; the dialog simply renders nothing while closed, so
  // toggling it never changes the hook order.
  if (!settingsOpen) return null;

  const hasSecretFor = (providerId: string): boolean =>
    (credentials.data ?? []).some((entry) => entry.providerId === providerId && entry.hasSecret);

  const saveSecret = async (providerId: string): Promise<void> => {
    const secret = secrets[providerId] ?? "";
    if (secret.trim().length === 0) {
      showToast("Enter a key before saving.", "warn");
      return;
    }
    try {
      await setCredential.mutateAsync({ providerId, secret });
      // Clear the field: the value now lives only in the OS keychain.
      setSecrets((current) => ({ ...current, [providerId]: "" }));
      showToast(`${providerId} credential stored in the OS credential store.`, "info");
    } catch (error) {
      showToast(`Could not store the credential: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const validate = async (providerId: string): Promise<void> => {
    const result = await testCredential.mutateAsync(providerId);
    setTestResult((current) => ({
      ...current,
      [providerId]: `${result.ok ? "OK" : "Failed"} · ${result.message}${result.latencyMs === null ? "" : ` (${result.latencyMs} ms)`}`,
    }));
  };

  const loadUsage = async (): Promise<void> => {
    if (!workspacePath) return;
    const usage = await getBridge().workspaceUsage({ workspacePath });
    setStorage({ bytes: usage.cacheBytes, reclaimable: usage.cacheReclaimableBytes });
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="dialog dialog--wide">
        <div className="dialog__header">
          <h2 className="dialog__title">Settings</h2>
          <button type="button" className="btn" onClick={() => setSettingsOpen(false)} aria-label="Close settings">
            Close
          </button>
        </div>

        <div className="settings-tabs" role="tablist" aria-label="Settings sections">
          {(
            [
              ["providers", "Providers"],
              ["models", "Model catalog"],
              ["budget", "Budget"],
              ["storage", "Storage"],
              ["accessibility", "Accessibility"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="settings-tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="dialog__body">
          {tab === "providers" ? (
            <section className="stack">
              <p className="small muted">
                Keys are written straight to the OS credential store through the native bridge. They are never rendered back, never put in a
                URL, never logged and never written into a project file (PRD §13).
              </p>
              {PROVIDERS.map((provider) => {
                const hasSecret = hasSecretFor(provider.id);
                return (
                  <div className="section" key={provider.id}>
                    <div className="section__header" style={{ cursor: "default" }}>
                      <span>{provider.label}</span>
                      <span className={`badge ${hasSecret ? "badge--success" : ""}`}>{hasSecret ? "key stored" : "no key"}</span>
                    </div>
                    <div className="section__body">
                      <div className="field">
                        <label htmlFor={`base-url-${provider.id}`}>Base URL</label>
                        <input
                          id={`base-url-${provider.id}`}
                          className="input"
                          value={baseUrls[provider.id] ?? ""}
                          onChange={(event) => setBaseUrls((current) => ({ ...current, [provider.id]: event.target.value }))}
                        />
                      </div>

                      <div className="secret-row">
                        <div className="field">
                          <label htmlFor={`secret-${provider.id}`}>API key (write-only)</label>
                          <input
                            id={`secret-${provider.id}`}
                            className="input"
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={hasSecret ? "•••••••• (stored)" : "Paste a key"}
                            value={secrets[provider.id] ?? ""}
                            onChange={(event) => setSecrets((current) => ({ ...current, [provider.id]: event.target.value }))}
                            aria-describedby={`secret-help-${provider.id}`}
                          />
                          <span className="small muted" id={`secret-help-${provider.id}`}>
                            The field clears after saving; the value is never echoed back.
                          </span>
                        </div>
                        <div className="row">
                          <button type="button" className="btn btn--primary" onClick={() => void saveSecret(provider.id)}>
                            Save key
                          </button>
                          <button
                            type="button"
                            className="btn"
                            disabled={!hasSecret || testCredential.isPending}
                            onClick={() => void validate(provider.id)}
                          >
                            Validate connection
                          </button>
                          <button
                            type="button"
                            className="btn btn--danger"
                            disabled={!hasSecret}
                            onClick={() =>
                              void deleteCredential
                                .mutateAsync(provider.id)
                                .then(() => showToast(`Removed the ${provider.id} credential.`, "warn"))
                                .catch((error: unknown) =>
                                  showToast(`Could not remove the credential: ${error instanceof Error ? error.message : String(error)}`, "error"),
                                )
                            }
                          >
                            Remove
                          </button>
                        </div>
                      </div>

                      {testResult[provider.id] ? (
                        <p className="small" role="status">
                          {testResult[provider.id]}
                        </p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              <span className="sr-only" role="status" aria-live="polite">
                {credentials.isFetching ? "Refreshing credential list" : `${credentials.data?.length ?? 0} credentials stored`}
              </span>
            </section>
          ) : null}

          {tab === "models" ? (
            <section className="stack">
              <div className="row">
                <span className="small muted">
                  Last refreshed {formatRelative(models.data?.fetchedAt)} ({formatTimestamp(models.data?.fetchedAt)})
                </span>
                <div className="spacer" />
                <label className="row small">
                  stale after
                  <input
                    type="number"
                    min={1}
                    max={90}
                    value={staleDays}
                    style={{ width: 64 }}
                    aria-label="Days before a catalog entry is considered stale"
                    onChange={(event) => setStaleDays(Math.max(1, Number(event.target.value) || 1))}
                  />
                  days
                </label>
                <button type="button" className="btn" disabled={refreshCatalog.isPending} onClick={() => void refreshCatalog.mutateAsync(undefined)}>
                  {refreshCatalog.isPending ? "Refreshing…" : "Refresh catalog"}
                </button>
              </div>

              {(models.data?.errors ?? []).length > 0 ? (
                <p className="callout callout--warning">
                  {(models.data?.errors ?? []).map((error) => `${error.providerId}: ${error.message}`).join(" · ")}
                </p>
              ) : null}

              <div className="model-catalog">
                <table>
                  <caption className="sr-only">Cached model catalog with capabilities and pricing</caption>
                  <thead>
                    <tr>
                      <th scope="col">Model</th>
                      <th scope="col">Provider</th>
                      <th scope="col">Modality</th>
                      <th scope="col">Modes</th>
                      <th scope="col">Negative prompt</th>
                      <th scope="col">Pricing</th>
                      <th scope="col">Fetched</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(models.data?.models ?? []).map((model) => {
                      const capabilities = model.capabilities as Record<string, unknown>;
                      const modes = Array.isArray(capabilities["modes"]) ? (capabilities["modes"] as string[]) : [];
                      const price = typeof capabilities["unitPrice"] === "number" ? (capabilities["unitPrice"] as number) : null;
                      const unit = typeof (capabilities["pricing"] as Record<string, unknown> | null)?.["unit"] === "string"
                        ? String((capabilities["pricing"] as Record<string, unknown>)["unit"])
                        : "job";
                      const staleAge = model.fetchedAt
                        ? Date.now() - Date.parse(model.fetchedAt) > staleDays * 86_400_000
                        : false;
                      return (
                        <tr key={`${model.providerId}/${model.modelId}`}>
                          <td className="mono">{model.modelId}</td>
                          <td>{model.providerId}</td>
                          <td>{model.modality}</td>
                          <td className="small">{modes.join(", ") || "—"}</td>
                          <td>{capabilities["supportsNegativePrompt"] === true ? "yes" : "no"}</td>
                          <td className="mono">{price === null ? "unknown" : formatMoney({ amount: price, currency: "USD" })} / {unit}</td>
                          <td className="small">
                            {formatRelative(model.fetchedAt)}
                            {model.isStale || staleAge ? <span className="badge badge--warning" style={{ marginLeft: 6 }}>stale</span> : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {tab === "budget" ? (
            <section className="stack">
              <p className="small muted">
                These limits are checked before every paid submission; an unknown price is treated as unknown, never as free (PRD §13).
              </p>
              <div className="field-grid">
                <div className="field">
                  <label htmlFor="budget-per-job">Per-job cap</label>
                  <input
                    id="budget-per-job"
                    className="input"
                    type="number"
                    min={0}
                    step={0.5}
                    value={policy.maxCostPerJob ?? 0}
                    onChange={(event) => setPolicy({ ...policy, maxCostPerJob: Number(event.target.value) || 0 })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="budget-daily">Daily ceiling</label>
                  <input
                    id="budget-daily"
                    className="input"
                    type="number"
                    min={0}
                    step={1}
                    value={policy.dailyCeiling ?? 0}
                    onChange={(event) => setPolicy({ ...policy, dailyCeiling: Number(event.target.value) || 0 })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="budget-approval">Require approval above</label>
                  <input
                    id="budget-approval"
                    className="input"
                    type="number"
                    min={0}
                    step={0.5}
                    value={policy.requireApprovalAbove ?? 0}
                    onChange={(event) => setPolicy({ ...policy, requireApprovalAbove: Number(event.target.value) || 0 })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="budget-currency">Currency</label>
                  <select
                    id="budget-currency"
                    className="select"
                    value={policy.currency}
                    onChange={(event) => setPolicy({ ...policy, currency: event.target.value })}
                  >
                    {["USD", "EUR", "GBP"].map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <label className="row small">
                <input
                  type="checkbox"
                  checked={policy.blockUnknownPricing}
                  onChange={(event) => setPolicy({ ...policy, blockUnknownPricing: event.target.checked })}
                />
                Block jobs whose price the provider cannot quote
              </label>
              <p className="small muted">
                Current policy: {formatMoney({ amount: policy.maxCostPerJob ?? 0, currency: policy.currency })} per job ·{" "}
                {formatMoney({ amount: policy.dailyCeiling ?? 0, currency: policy.currency })} per day · approval above{" "}
                {formatMoney({ amount: policy.requireApprovalAbove ?? 0, currency: policy.currency })}.
              </p>
            </section>
          ) : null}

          {tab === "storage" ? (
            <section className="stack">
              <div className="row">
                <button type="button" className="btn" onClick={() => void loadUsage()} disabled={!workspacePath}>
                  Measure cache
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={!workspacePath || !storage}
                  onClick={() =>
                    void getBridge()
                      .workspacePurgeCaches({ workspacePath: workspacePath ?? "" })
                      .then((response) => {
                        showToast(`Cleaned ${response.purged.length} cache directories.`, "info");
                        setStorage({ bytes: 0, reclaimable: 0 });
                      })
                      .catch((error: unknown) => showToast(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "error"))
                  }
                >
                  Clean reclaimable cache
                </button>
                <div className="spacer" />
                <span className="small muted">{workspacePath ?? "no workspace open"}</span>
              </div>
              <dl className="provenance-grid">
                <dt>Cache size</dt>
                <dd className="mono">{storage ? formatBytes(storage.bytes) : "—"}</dd>
                <dt>Reclaimable</dt>
                <dd className="mono">{storage ? formatBytes(storage.reclaimable) : "—"}</dd>
              </dl>
              <p className="small muted">
                Thumbnails, waveforms and proxies are derived data and safe to delete; originals, generated outputs and exports never are
                (PRD §11).
              </p>
            </section>
          ) : null}

          {tab === "accessibility" ? (
            <section className="stack">
              <label className="row small">
                <input
                  type="checkbox"
                  checked={reducedMotion}
                  onChange={async (event) => {
                    const enabled = event.target.checked;
                    setReducedMotion(enabled);
                    // Persisted through the bridge, not localStorage, so the native shell and the
                    // webview agree (PRD §14).
                    await getBridge().settingsSet({ key: UI_SETTINGS_KEY, value: { ...snapshot(), reducedMotion: enabled } });
                    showToast(`Reduced motion ${enabled ? "enabled" : "disabled"}.`, "info");
                  }}
                />
                Reduce motion (also honours the system setting)
              </label>
              <p className="small muted">
                Transitions and progress animations are disabled. Focus rings, screen-reader labels and keyboard navigation stay on in both
                modes.
              </p>
              <dl className="provenance-grid">
                <dt>Shortcuts</dt>
                <dd>
                  Space play/pause · J/K/L transport · S split · N snap · +/- zoom · Delete remove · Shift+Delete ripple delete · Cmd/Ctrl+Z
                  undo · Shift+Cmd/Ctrl+Z redo · Cmd/Ctrl+A select all · Escape clear selection
                </dd>
                <dt>Text contrast</dt>
                <dd>Body text meets WCAG AA (≥ 4.5:1) against every surface in the theme.</dd>
              </dl>
            </section>
          ) : null}
        </div>

        <div className="dialog__footer">
          <span className="small muted">
            Bridge: {getBridge().kind === "tauri" ? "native IPC (allowlisted)" : "in-memory mock"}
          </span>
          <div className="spacer" />
          <button type="button" className="btn btn--primary" onClick={() => setSettingsOpen(false)}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
