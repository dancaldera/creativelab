//! `media_*` commands: thumbnail, waveform, proxy.
//!
//! Every output is written through [`crate::security::WorkspaceScope`] into
//! `cache/thumbnails`, `cache/waveforms` and `cache/proxies`, and the response carries the
//! **workspace-relative** path so the renderer never learns an absolute filesystem path it
//! did not already have to choose.

use tauri::State;

use crate::commands::support::{CommandError, CommandResult};
use crate::db::migrate::now_iso8601;
use crate::media;
use crate::protocol::*;
use crate::security::WorkspaceScope;
use crate::state::AppState;

use super::assets::asset_path;

/// Cache keys are content-addressed by asset id plus the parameters that change the
/// output, so regenerating the same thumbnail twice is a no-op.
fn cache_name(asset_id: &str, suffix: &str) -> String {
    let safe: String = asset_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!("{safe}-{suffix}")
}

/// `media_thumbnail`.
#[tauri::command]
pub fn media_thumbnail(
    state: State<'_, AppState>,
    request: MediaThumbnailRequest,
) -> CommandResult<MediaThumbnailResponse> {
    let (_root, scope) = super::workspace::scope_for_request(&state, &request.workspace_path)?;
    if !request.at_seconds.is_finite() || request.at_seconds < 0.0 {
        return Err(CommandError::validation(
            "atSeconds must be a finite, non-negative number",
        ));
    }
    if request.width <= 0 {
        return Err(CommandError::validation("width must be positive"));
    }
    let asset = load_asset(&state, &request.asset_id)?;
    let source = asset_path(&scope, &asset)?;
    let relative = format!(
        "cache/thumbnails/{}",
        cache_name(
            &asset.id,
            &format!(
                "{}s-{}.png",
                media::format_number(request.at_seconds, 3),
                request.width
            )
        )
    );
    let destination = scope.resolve(&relative)?;
    let (width, height) = block_on(media::generate_thumbnail(
        &source,
        &destination,
        request.at_seconds,
        request.width,
    ))??;
    Ok(MediaThumbnailResponse {
        relative_path: relative,
        width,
        height,
    })
}

/// `media_waveform`.
#[tauri::command]
pub fn media_waveform(
    state: State<'_, AppState>,
    request: MediaWaveformRequest,
) -> CommandResult<MediaWaveformResponse> {
    let (_root, scope) = super::workspace::scope_for_request(&state, &request.workspace_path)?;
    if request.buckets <= 0 || request.buckets > 200_000 {
        return Err(CommandError::validation(
            "buckets must be between 1 and 200000",
        ));
    }
    let asset = load_asset(&state, &request.asset_id)?;
    let source = asset_path(&scope, &asset)?;
    let relative = format!(
        "cache/waveforms/{}",
        cache_name(&asset.id, &format!("{}.json", request.buckets))
    );
    let destination = scope.resolve(&relative)?;
    let peaks = block_on(media::generate_waveform(
        &source,
        &destination,
        request.buckets,
    ))??;
    Ok(MediaWaveformResponse {
        relative_path: relative,
        buckets: request.buckets,
        peaks,
    })
}

/// `media_proxy`.
#[tauri::command]
pub fn media_proxy(
    state: State<'_, AppState>,
    request: MediaProxyRequest,
) -> CommandResult<MediaProxyResponse> {
    let (_root, scope) = super::workspace::scope_for_request(&state, &request.workspace_path)?;
    if request.max_width <= 0 {
        return Err(CommandError::validation("maxWidth must be positive"));
    }
    let asset = load_asset(&state, &request.asset_id)?;
    let source = asset_path(&scope, &asset)?;
    let relative = format!(
        "cache/proxies/{}",
        cache_name(&asset.id, &format!("w{}.mp4", request.max_width))
    );
    let destination = scope.resolve(&relative)?;

    // Reuse a proxy that is already newer than its source.
    if let (Ok(existing), Ok(origin)) =
        (std::fs::metadata(&destination), std::fs::metadata(&source))
    {
        if let (Ok(existing_time), Ok(origin_time)) = (existing.modified(), origin.modified()) {
            if existing_time >= origin_time && existing.len() > 0 {
                if let Ok(probe) = media::probe_file_blocking(&destination) {
                    return Ok(MediaProxyResponse {
                        relative_path: relative,
                        width: probe.width.unwrap_or(request.max_width),
                        height: probe.height.unwrap_or(0),
                        bytes: existing.len() as i64,
                    });
                }
            }
        }
    }

    let (width, height, bytes) = block_on(media::generate_proxy(
        &source,
        &destination,
        request.max_width,
    ))??;
    Ok(MediaProxyResponse {
        relative_path: relative,
        width,
        height,
        bytes,
    })
}

/// Note the proxy's existence and timestamp so a later run can reuse it.
#[allow(dead_code)]
fn touch_proxy(
    connection: &rusqlite::Connection,
    asset_id: &str,
    relative: &str,
) -> CommandResult<()> {
    let key = format!("proxy.{asset_id}");
    let value = serde_json::json!({ "relativePath": relative, "generatedAt": now_iso8601() });
    crate::db::store::set_setting(connection, &key, &value)
}

/// Load an asset, naming the id when it is unknown.
pub fn load_asset(state: &State<'_, AppState>, asset_id: &str) -> CommandResult<AssetDto> {
    if asset_id.trim().is_empty() {
        return Err(CommandError::validation("assetId must not be empty"));
    }
    state
        .with_db(|connection| crate::db::store::find_asset(connection, asset_id))?
        .ok_or_else(|| CommandError::validation(format!("unknown asset {asset_id}")))
}

/// Drive an async ffmpeg helper to completion from a synchronous command.
///
/// Commands are declared synchronous so Tauri runs them on its blocking thread pool; a
/// current-thread Tokio runtime scoped to this call keeps the `async` media helpers
/// reusable by other callers without making the command `async` (which would let a
/// blocking SQLite lock sit on the async runtime).
pub fn block_on<F: std::future::Future>(future: F) -> CommandResult<F::Output> {
    // `new_current_thread` needs only the lighter `rt` feature; the media helpers are
    // short-lived and do not fan out, so a multi-thread runtime would be wasted here.
    Ok(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| {
            CommandError::internal(format!("could not start a worker runtime: {error}"))
        })?
        .block_on(future))
}

/// Re-exported for the render command, which needs the same scoping rule.
pub fn scoped_relative(
    scope: &WorkspaceScope,
    relative: &str,
) -> CommandResult<std::path::PathBuf> {
    Ok(scope.resolve(relative)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_names_are_single_safe_segments() {
        assert_eq!(cache_name("ast_abc", "1s-320.png"), "ast_abc-1s-320.png");
        // A hostile asset id cannot introduce a separator or a traversal component.
        let hostile = cache_name("../../etc/passwd", "x.png");
        assert!(!hostile.contains('/'), "{hostile}");
        assert!(!hostile.contains(".."), "{hostile}");
        assert_eq!(hostile, "______etc_passwd-x.png");
    }

    #[test]
    fn cache_paths_stay_inside_the_cache_directories() {
        let base = std::env::temp_dir().join(format!("creativelab-media-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        crate::db::ensure_workspace_layout(&base).unwrap();
        // Canonicalize so the containment check compares real paths on macOS.
        let root = std::fs::canonicalize(&base).unwrap();
        let scope = WorkspaceScope::new(&root);
        for relative in [
            format!("cache/thumbnails/{}", cache_name("../../x", "1s-320.png")),
            format!("cache/waveforms/{}", cache_name("a/b", "64.json")),
            format!("cache/proxies/{}", cache_name("a\\b", "w960.mp4")),
        ] {
            let resolved = scope.resolve(&relative).unwrap();
            assert!(resolved.starts_with(root.join("cache")), "{resolved:?}");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn block_on_drives_a_future_to_completion() {
        let value = block_on(async { 7 + 35 }).unwrap();
        assert_eq!(value, 42);
    }
}
