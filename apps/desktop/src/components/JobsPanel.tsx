/**
 * `JobsPanel` — the generation/export queue (FR-10, PRD §12).
 *
 * The panel is deliberately explicit about `unknown`: those jobs are never auto-retried
 * (a re-submission could bill twice), so they get their own section with a manual decision
 * and the reason the reconciler recorded.
 */
import { useEffect } from "react";
import { getBridge } from "../bridge";
import { useCancelJob, useJobReconcile, useJobs, useRetryJob } from "../hooks/queries";
import { useEditorStore } from "../state/editorStore";
import { useJobsStore } from "../state/jobsStore";
import { useUiStore } from "../state/uiStore";
import { formatMoney } from "../utils/money";
import { formatPercent, formatTimestamp } from "../utils/format";

export function JobsPanel() {
  const jobsOpen = useUiStore((state) => state.jobsOpen);
  const setJobsOpen = useUiStore((state) => state.setJobsOpen);
  const storyboardOpen = useUiStore((state) => state.storyboardOpen);
  const workspacePath = useEditorStore((state) => state.workspacePath);
  const showToast = useUiStore((state) => state.showToast);

  const jobsQuery = useJobs([], true);
  const reconcileQuery = useJobReconcile(true);
  const cancelJob = useCancelJob();
  const retryJob = useRetryJob();

  const jobs = useJobsStore((state) => state.jobs);
  const needsAttention = useJobsStore((state) => state.needsAttention);
  const resumed = useJobsStore((state) => state.resumed);
  const syncJobs = useJobsStore((state) => state.syncJobs);
  const syncReconcile = useJobsStore((state) => state.syncReconcile);
  const resolveAttention = useJobsStore((state) => state.resolveAttention);
  const setError = useJobsStore((state) => state.setError);

  useEffect(() => {
    if (jobsQuery.data) syncJobs(jobsQuery.data.jobs);
  }, [jobsQuery.data, syncJobs]);

  useEffect(() => {
    if (jobsQuery.error) setError(jobsQuery.error instanceof Error ? jobsQuery.error.message : String(jobsQuery.error));
  }, [jobsQuery.error, setError]);

  useEffect(() => {
    if (reconcileQuery.data) syncReconcile(reconcileQuery.data.needsAttention, reconcileQuery.data.resumed);
  }, [reconcileQuery.data, syncReconcile]);

  const unknownJobs = jobs.filter((job) => job.status === "unknown");
  const retryable = jobs.filter((job) => job.status === "failed" && job.retryCount < 4);
  const active = jobs.filter((job) => !["completed", "canceled"].includes(job.status));

  if (!jobsOpen && !storyboardOpen && jobs.length === 0) {
    // Nothing to show and nothing asked for: stay out of the way.
    return null;
  }

  const body = (
    <div className="dialog__body">
      <p className="small muted">
        Workspace: <code className="mono">{workspacePath ?? "none"}</code>
        {jobsQuery.isFetching ? " · polling…" : jobsQuery.dataUpdatedAt ? ` · last poll ${formatTimestamp(new Date(jobsQuery.dataUpdatedAt).toISOString())}` : ""}
      </p>

      {unknownJobs.length > 0 ? (
        <section className="stack" aria-labelledby="jobs-unknown-heading">
          <h3 className="section-title" id="jobs-unknown-heading">
            Needs a manual decision ({unknownJobs.length})
          </h3>
          <p className="callout callout--warning">
            These jobs were in flight when the app stopped and their submission outcome is unverified. Retrying automatically could
            charge you twice, so nothing is retried until you decide.
          </p>
          {unknownJobs.map((job) => {
            const notice = needsAttention.find((entry) => entry.jobId === job.id);
            return (
              <div className="job-row" key={job.id}>
                <div className="job-row__title">
                  <span className="job-row__model mono">{job.modelId}</span>
                  <span className="job-row__sub">
                    {job.providerId} · {job.mode} · {notice?.reason ?? "uncertain submission outcome"}
                  </span>
                </div>
                <span className="badge badge--warning">{formatPercent(job.progress)}</span>
                <span className="small muted mono">{job.costEstimate ? formatMoney(job.costEstimate) : "—"}</span>
                <div className="job-row__actions">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      resolveAttention(job.id);
                      showToast(`Marked ${job.id} as reviewed; no request was re-sent.`, "info");
                    }}
                  >
                    Mark reviewed
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={!workspacePath || cancelJob.isPending}
                    onClick={() =>
                      void cancelJob.mutateAsync(job.id).catch((error: unknown) =>
                        showToast(`Cancel failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
                      )
                    }
                  >
                    Cancel
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      ) : null}

      <section className="stack" aria-labelledby="jobs-active-heading">
        <h3 className="section-title" id="jobs-active-heading">
          In flight ({active.length})
        </h3>
        {active.length === 0 ? <p className="small muted">No jobs are running.</p> : null}
        {active.map((job) => (
          <div className="job-row" key={job.id}>
            <div className="job-row__title">
              <span className="job-row__model mono">{job.modelId}</span>
              <span className="job-row__sub">
                {job.providerId} · {job.mode} · attempt {job.retryCount + 1}
              </span>
            </div>
            <div>
              <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((job.progress ?? 0) * 100)}>
                <div className="progress__fill" style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} />
              </div>
              <span className="small muted">{formatPercent(job.progress)}</span>
            </div>
            <span className="small muted mono">{job.costEstimate ? formatMoney(job.costEstimate) : "—"}</span>
            <div className="job-row__actions">
              <button
                type="button"
                className="btn"
                disabled={!workspacePath || cancelJob.isPending}
                onClick={() =>
                  void cancelJob
                    .mutateAsync(job.id)
                    .then(() => showToast(`Canceled ${job.id}.`, "info"))
                    .catch((error: unknown) => showToast(`Cancel failed: ${error instanceof Error ? error.message : String(error)}`, "error"))
                }
              >
                Cancel
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="stack" aria-labelledby="jobs-failed-heading">
        <h3 className="section-title" id="jobs-failed-heading">
          Failed and retryable ({retryable.length})
        </h3>
        {retryable.length === 0 ? <p className="small muted">No retryable failures.</p> : null}
        {retryable.map((job) => (
          <div className="job-row" key={job.id}>
            <div className="job-row__title">
              <span className="job-row__model mono">{job.modelId}</span>
              <span className="job-row__sub">{String((job.error as Record<string, unknown> | null)?.["message"] ?? "transient failure")}</span>
            </div>
            <span className="badge badge--danger">failed</span>
            <span className="small muted mono">{job.actualCost ? formatMoney(job.actualCost) : "—"}</span>
            <div className="job-row__actions">
              <button
                type="button"
                className="btn"
                disabled={!workspacePath || retryJob.isPending}
                onClick={() =>
                  void retryJob
                    .mutateAsync(job.id)
                    .then(() => showToast(`Retrying ${job.id}.`, "info"))
                    .catch((error: unknown) => showToast(`Retry failed: ${error instanceof Error ? error.message : String(error)}`, "error"))
                }
              >
                Retry
              </button>
            </div>
          </div>
        ))}
      </section>

      {resumed.length > 0 ? (
        <p className="callout callout--info">
          Resumed polling for {resumed.length} job{resumed.length === 1 ? "" : "s"} that already had a provider job id, so no new request was
          sent.
        </p>
      ) : null}

      <p className="small muted">
        Cost control is enforced before submission: per-job caps, a daily ceiling and an approval threshold all live in Settings → Budget.
      </p>
    </div>
  );

  if (!jobsOpen) {
    return (
      <section className="rail__panel" aria-label="Background jobs" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <header className="rail__panel-header">
          <h2 className="rail__panel-title">Background jobs</h2>
          <button type="button" className="btn" onClick={() => setJobsOpen(true)} aria-expanded={false}>
            Expand
          </button>
        </header>
        {body}
      </section>
    );
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Job queue">
      <div className="dialog dialog--wide">
        <div className="dialog__header">
          <h2 className="dialog__title">Jobs and budgets</h2>
          <button type="button" className="btn" onClick={() => setJobsOpen(false)} aria-label="Close the job queue">
            Close
          </button>
        </div>
        {body}
        <div className="dialog__footer">
          <span className="small muted">
            {getBridge().kind === "mock" ? "Mock bridge: jobs are simulated in memory." : "Native bridge: durable job queue."}
          </span>
          <div className="spacer" />
          <button type="button" className="btn" onClick={() => void jobsQuery.refetch()}>
            Refresh now
          </button>
        </div>
      </div>
    </div>
  );
}
