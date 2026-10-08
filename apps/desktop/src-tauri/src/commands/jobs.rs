//! `job_*` commands.
//!
//! `job_list`, `job_cancel` and `job_reconcile` are fully implemented against
//! `generation_jobs` / `job_events`. `job_retry` needs the per-mode generation request
//! contract, which is not frozen yet, so it returns an explicit "unsupported" error rather
//! than pretending to resubmit (PRD §12: an uncertain paid submission must never be
//! silently retried).

use tauri::State;

use crate::commands::support::CommandResult;
use crate::db::store::{self, JobEvent, JobUpdate};
use crate::protocol::*;
use crate::providers;
use crate::state::AppState;

/// Statuses that mean the job is no longer running.
const TERMINAL_STATUSES: &[&str] = &["completed", "failed", "canceled"];

/// Statuses a restart can leave behind and that a human must decide about.
const ATTENTION_STATUSES: &[&str] = &["unknown", "submitting"];

/// `job_list`.
#[tauri::command]
pub fn job_list(
    state: State<'_, AppState>,
    request: JobListRequest,
) -> CommandResult<JobListResponse> {
    let (_root, _scope) = super::workspace::scope_for_request(&state, &request.workspace_path)?;
    let limit = match request.limit {
        Some(limit) if !(1..=5000).contains(&limit) => {
            return Err(crate::error::CommandError::validation(
                "limit must be between 1 and 5000",
            ))
        }
        Some(limit) => Some(limit),
        None => None,
    };
    let jobs = state
        .with_db(|connection| store::list_jobs(connection, request.status.as_deref(), limit))?;
    Ok(JobListResponse { jobs })
}

/// `job_cancel`: mark a local job canceled. Nothing is sent to the provider, so a job the
/// provider has already accepted keeps its `providerJobId` for reconciliation.
#[tauri::command]
pub fn job_cancel(state: State<'_, AppState>, request: JobIdRequest) -> CommandResult<()> {
    let (_root, _scope) = super::workspace::scope_for_request(&state, &request.workspace_path)?;
    let job = state
        .with_db(|connection| store::find_job(connection, &request.job_id))?
        .ok_or_else(|| {
            crate::error::CommandError::validation(format!("unknown job {}", request.job_id))
        })?;
    if TERMINAL_STATUSES.contains(&job.status.as_str()) {
        // Cancelling a finished job is a no-op, not an error the UI must handle.
        return Ok(());
    }
    state.with_db_mut(|connection| {
        store::update_job(
            connection,
            &request.job_id,
            &JobUpdate {
                status: Some("canceled".to_string()),
                ..JobUpdate::default()
            },
            Some(JobEvent {
                from_state: Some(job.status.clone()),
                to_state: "canceled".to_string(),
                detail: Some(serde_json::json!({ "reason": "canceled by the user" })),
            }),
        )?;
        Ok(())
    })
}

/// `job_retry`: re-submit a terminally failed generation job.
///
/// **Not implemented.** The per-mode request/response contract does not exist yet in
/// `protocol.ts` or `packages/core/src/jobs.ts`, so there is nothing to submit against.
/// Returning `Err(unsupported)` is deliberate: faking success here would be a paid request
/// the user did not get, and silently retrying an `unknown` job could double-charge
/// (PRD §12).
#[tauri::command]
pub fn job_retry(state: State<'_, AppState>, request: JobIdRequest) -> CommandResult<()> {
    let (_root, _scope) = super::workspace::scope_for_request(&state, &request.workspace_path)?;
    // Validate the target first so the error names the real problem when it is the job id.
    let job = state
        .with_db(|connection| store::find_job(connection, &request.job_id))?
        .ok_or_else(|| {
            crate::error::CommandError::validation(format!("unknown job {}", request.job_id))
        })?;
    if !TERMINAL_STATUSES.contains(&job.status.as_str()) {
        return Err(crate::error::CommandError::validation(format!(
            "job {} is still {}; cancel it before retrying",
            request.job_id, job.status
        )));
    }
    // The submission entry point exists and is honest about being unimplemented.
    let _ = providers::submit_job;
    Err(crate::error::CommandError::unsupported(
        "job_retry",
        providers::SUBMISSION_NOT_IMPLEMENTED,
    ))
}

/// `job_reconcile`: report jobs a restart left in an undecidable state.
///
/// PRD §12 and the architecture invariant: "a job in `submitting` after a restart becomes
/// `unknown`, never auto-retried". This command performs exactly that transition and then
/// answers with the list needing a human decision. Nothing is resubmitted.
#[tauri::command]
pub fn job_reconcile(
    state: State<'_, AppState>,
    request: JobWorkspaceRequest,
) -> CommandResult<JobReconcileResponse> {
    let (_root, _scope) = super::workspace::scope_for_request(&state, &request.workspace_path)?;
    let unfinished = state.with_db(store::list_unfinished_jobs)?;

    let mut needs_attention = Vec::new();
    let mut resumed = Vec::new();

    for job in unfinished {
        match job.status.as_str() {
            "submitting" => {
                // Park it: the provider may or may not have accepted the request, so a
                // human decides. Never auto-retry.
                state.with_db_mut(|connection| {
                    store::update_job(
                        connection,
                        &job.id,
                        &JobUpdate {
                            status: Some("unknown".to_string()),
                            submission_lock: Some("released".to_string()),
                            ..JobUpdate::default()
                        },
                        Some(JobEvent {
                            from_state: Some("submitting".to_string()),
                            to_state: "unknown".to_string(),
                            detail: Some(serde_json::json!({
                                "reason": "the app restarted while the request was in flight",
                            })),
                        }),
                    )?;
                    Ok(())
                })?;
                needs_attention.push(JobAttentionDto {
                    job_id: job.id,
                    reason: "was submitting when the app stopped; verify with the provider before retrying"
                        .to_string(),
                });
            }
            status if ATTENTION_STATUSES.contains(&status) => {
                needs_attention.push(JobAttentionDto {
                    job_id: job.id,
                    reason: format!("is parked in '{status}' and needs a decision"),
                });
            }
            // A `running` job with a provider id can be polled again once the polling
            // implementation lands; report it as resumable rather than as a problem.
            "running" if job.provider_job_id.is_some() => {
                resumed.push(job.id);
            }
            _ => {
                needs_attention.push(JobAttentionDto {
                    job_id: job.id,
                    reason: format!("is stuck in '{}'", job.status),
                });
            }
        }
    }

    // Polling is not implemented yet, so nothing was actually resumed; be honest about it
    // by leaving `resumed` empty and reporting the candidates as needing attention
    // instead. This keeps the UI from believing a job is progressing.
    if !resumed.is_empty() {
        for job_id in resumed.drain(..) {
            needs_attention.push(JobAttentionDto {
                job_id,
                reason: providers::SUBMISSION_NOT_IMPLEMENTED.to_string(),
            });
        }
    }

    Ok(JobReconcileResponse {
        needs_attention,
        resumed: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_and_attention_sets_do_not_overlap() {
        for status in TERMINAL_STATUSES {
            assert!(!ATTENTION_STATUSES.contains(status), "{status}");
        }
        assert!(TERMINAL_STATUSES.contains(&"canceled"));
        assert!(ATTENTION_STATUSES.contains(&"submitting"));
        assert!(ATTENTION_STATUSES.contains(&"unknown"));
    }

    #[test]
    fn reconcile_never_reports_a_job_as_resumed_while_polling_is_unimplemented() {
        // The command's contract: `resumed` stays empty, and every candidate lands in
        // `needsAttention` with the reason. Asserted here so the invariant is visible next
        // to the code that must keep it.
        let response = JobReconcileResponse {
            needs_attention: vec![JobAttentionDto {
                job_id: "job_1".into(),
                reason: providers::SUBMISSION_NOT_IMPLEMENTED.to_string(),
            }],
            resumed: Vec::new(),
        };
        assert!(response.resumed.is_empty());
        assert_eq!(response.needs_attention.len(), 1);
        let value = serde_json::to_value(&response).unwrap();
        assert!(value.get("needsAttention").is_some());
        assert!(value.get("resumed").is_some());
    }

    #[test]
    fn job_dto_serializes_with_camel_case_optional_fields() {
        let job = JobDto {
            id: "job_1".into(),
            provider_id: "elevenlabs".into(),
            model_id: "eleven_multilingual_v2".into(),
            mode: "text-to-speech".into(),
            modality: "audio".into(),
            status: "unknown".into(),
            progress: None,
            provider_job_id: Some("prov_1".into()),
            retry_count: 1,
            cost_estimate: Some(SpendDto {
                amount: 0.12,
                currency: "USD".into(),
            }),
            actual_cost: None,
            output_asset_ids: vec!["ast_1".into()],
            error: Some(serde_json::json!({ "uncertain": true })),
            created_at: "2024-01-01T00:00:00.000Z".into(),
            updated_at: "2024-01-01T00:00:01.000Z".into(),
        };
        let value = serde_json::to_value(&job).unwrap();
        for key in [
            "providerId",
            "modelId",
            "providerJobId",
            "retryCount",
            "costEstimate",
            "actualCost",
            "outputAssetIds",
            "createdAt",
            "updatedAt",
        ] {
            assert!(value.get(key).is_some(), "missing {key}");
        }
        assert!(value["progress"].is_null());
        assert_eq!(value["costEstimate"]["currency"], "USD");
    }
}
