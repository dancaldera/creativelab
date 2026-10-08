//! `render_*` commands: start, status, cancel.
//!
//! ## Threading model
//! The render itself runs on a dedicated OS thread with its own SQLite connection. It
//! writes `export_jobs` progress as it goes, so `render_status` (which reads through the
//! command connection) sees live progress without either thread holding a lock the other
//! needs. `render_cancel` flips the shared `AtomicBool` and signals the child process.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::State;

use crate::commands::support::CommandError;
use crate::commands::support::CommandResult;
use crate::db::{self, store};
use crate::media;
use crate::protocol::*;
use crate::render::{self, AudioGraphClip, GraphConfig, RenderJob, VideoGraphClip};
use crate::security::WorkspaceScope;
use crate::state::{AppState, RenderCancelHandle};

use super::assets::asset_path;

/// `render_start`.
#[tauri::command]
pub fn render_start(
    state: State<'_, AppState>,
    request: RenderStartRequest,
) -> CommandResult<RenderStartResponse> {
    let (root, scope) = super::workspace::scope_for_request(&state, &request.workspace_path)?;
    if request.sequence_id.trim().is_empty() {
        return Err(CommandError::validation("sequenceId must not be empty"));
    }
    // `outputPath` comes from a save panel, so it is validated as an absolute file path with
    // an existing parent — never scoped into the workspace, because exporting outside it is
    // the point.
    let output_path = scope.resolve_absolute_file(&request.output_path, "outputPath")?;

    let document = state.with_db(store::load_document)?;
    let preset = {
        let sequence = document
            .sequences
            .iter()
            .find(|sequence| sequence.id == request.sequence_id)
            .ok_or_else(|| {
                CommandError::validation(format!("unknown sequence {}", request.sequence_id))
            })?;
        render::resolve_preset(&request.preset_id, sequence.fps)?
    };

    let plan = build_render_plan(&document, &request.sequence_id, &scope, &preset)?;
    let document_project_id = document.project.id.clone();
    let sample_rate = document.project.sample_rate;

    let config = GraphConfig {
        width: preset.width,
        height: preset.height,
        fps: preset.fps,
        sequence_fps: plan.sequence_fps,
        duration_frames: plan.duration_frames,
        pixel_format: preset.pixel_format.clone(),
        sample_rate,
    };
    let graph = render::build_filter_graph(&config, &plan.video, &plan.audio)?;
    let total_frames = graph.total_frames;

    // Persist the export row before spawning, so a crash after spawn still leaves an audit
    // record the reconciler can find.
    let export_job_id = state.next_id("exportJob");
    let now = crate::db::migrate::now_iso8601();
    let row = store::ExportJobRow {
        id: export_job_id.clone(),
        project_id: document_project_id,
        sequence_id: request.sequence_id.clone(),
        preset: serde_json::json!({
            "id": preset.id,
            "label": preset.id,
            "container": "mp4",
            "videoCodec": "h264",
            "audioCodec": "aac",
            "width": preset.width,
            "height": preset.height,
            "fps": { "num": preset.fps.num, "den": preset.fps.den },
            "videoBitrateKbps": preset.video_bitrate_kbps,
            "audioBitrateKbps": preset.audio_bitrate_kbps,
            "crf": preset.crf,
            "pixelFormat": preset.pixel_format,
            "burnInCaptions": request.burn_in_captions.unwrap_or(false),
        }),
        output_path: output_path.to_string_lossy().to_string(),
        status: RenderStatus::Queued.as_str().to_string(),
        progress: 0.0,
        rendered_frames: 0,
        total_frames,
        errors: Vec::new(),
        log_path: None,
        created_at: now.clone(),
        updated_at: now,
    };
    state.with_db(|connection| store::insert_export_job(connection, &row))?;

    let handle = Arc::new(RenderCancelHandle::new(export_job_id.clone()));
    state.register_render(Arc::clone(&handle))?;

    let job = RenderJob {
        workspace_root: root.clone(),
        export_job_id: export_job_id.clone(),
        output_path,
        inputs: plan.inputs,
        graph,
        preset,
        total_frames,
        handle: Arc::clone(&handle),
    };
    let workspace_root = root.clone();
    let id_for_thread = export_job_id.clone();
    std::thread::Builder::new()
        .name(format!("render-{id_for_thread}"))
        .spawn(move || {
            // The worker owns its own connection; SQLite handles the concurrency (WAL plus a
            // busy timeout) and `rusqlite::Connection` is `Send`.
            let outcome = match db::open_database(&workspace_root) {
                Ok(connection) => render::run_render(job, &connection),
                Err(error) => Err(error),
            };
            if let Err(error) = outcome {
                eprintln!("render {id_for_thread} ended: {error}");
            }
        })
        .map_err(|error| {
            CommandError::from_io("could not start the render worker thread", &error)
        })?;

    Ok(RenderStartResponse {
        export_job_id,
        total_frames,
    })
}

/// A fully resolved render plan: the `-i` list plus the clips that reference it.
///
/// Mirrors `buildFilterGraph` in `packages/media/src/graph.ts`, including the input-index
/// assignment order (**video clips first, then audio clips**) — that order is what makes
/// `[i:v]` / `[i:a]` line up between the two implementations.
struct RenderPlan {
    inputs: Vec<PathBuf>,
    video: Vec<VideoGraphClip>,
    audio: Vec<AudioGraphClip>,
    duration_frames: i64,
    sequence_fps: FrameRateDto,
}

fn build_render_plan(
    document: &DocumentDto,
    sequence_id: &str,
    scope: &WorkspaceScope,
    preset: &render::Preset,
) -> CommandResult<RenderPlan> {
    let sequence = document
        .sequences
        .iter()
        .find(|sequence| sequence.id == sequence_id)
        .ok_or_else(|| CommandError::validation(format!("unknown sequence {sequence_id}")))?;

    let clips: Vec<&ClipDto> = document
        .clips
        .iter()
        .filter(|clip| clip.sequence_id == sequence_id)
        .collect();
    if clips.is_empty() {
        return Err(CommandError::validation(
            "cannot render an empty timeline: the sequence has no clips",
        ));
    }
    // `sequenceDurationFrames`: the furthest clip end, not the stored column.
    let duration_frames = clips
        .iter()
        .map(|clip| clip.start_frame + clip.duration_frames)
        .max()
        .unwrap_or(0);
    if duration_frames <= 0 {
        return Err(CommandError::validation(
            "cannot render an empty timeline: its duration is zero frames",
        ));
    }

    let any_audio_solo = document
        .tracks
        .iter()
        .any(|track| track.kind == "audio" && track.solo);

    // Pass 1: select the participating clips, in document order.
    struct Selected<'a> {
        clip: &'a ClipDto,
        track: &'a TrackDto,
        asset: &'a AssetDto,
    }
    let mut video_selection: Vec<Selected<'_>> = Vec::new();
    let mut audio_selection: Vec<Selected<'_>> = Vec::new();

    for clip in &clips {
        let track = document
            .tracks
            .iter()
            .find(|track| track.id == clip.track_id)
            .ok_or_else(|| {
                CommandError::validation(format!(
                    "clip {} references unknown track {}",
                    clip.id, clip.track_id
                ))
            })?;
        if track.kind != "video" && track.kind != "audio" {
            continue;
        }
        let asset_id = clip.asset_id.as_deref().ok_or_else(|| {
            CommandError::validation(format!("clip {} has no asset; cannot render it", clip.id))
        })?;
        let asset = document
            .assets
            .iter()
            .find(|asset| asset.id == asset_id)
            .ok_or_else(|| {
                CommandError::validation(format!(
                    "clip {} references missing asset {asset_id}",
                    clip.id
                ))
            })?;

        // `sourceRange` = sourceIn .. sourceIn + ceil(duration * speedNum / speedDen).
        let (speed_num, speed_den) = store::clip_speed(clip);
        let span = ((clip.duration_frames as f64 * speed_num as f64) / speed_den as f64).ceil();
        if let Some(asset_frames) = asset.duration_frames {
            if clip.source_in_frame + span as i64 > asset_frames {
                return Err(CommandError::validation(format!(
                    "clip {} needs source frames [{}, {}) but asset {asset_id} has only {asset_frames}",
                    clip.id,
                    clip.source_in_frame,
                    clip.source_in_frame + span as i64
                )));
            }
        }

        if track.kind == "video" {
            if track.hidden {
                continue;
            }
            video_selection.push(Selected { clip, track, asset });
        } else {
            // `enabled: false` removes a clip from the mix without unlinking it.
            if !audio_properties(&clip.properties).enabled {
                continue;
            }
            if track.hidden || (track.muted && !track.solo) || (any_audio_solo && !track.solo) {
                continue;
            }
            if !asset.has_audio_stream() {
                continue;
            }
            audio_selection.push(Selected { clip, track, asset });
        }
    }

    if video_selection.is_empty() && audio_selection.is_empty() {
        return Err(CommandError::validation(
            "the sequence has no renderable clips; add media before exporting",
        ));
    }

    // Pass 2: one `-i` per distinct asset, video clips first.
    let mut inputs: Vec<PathBuf> = Vec::new();
    let mut input_index_by_asset: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let assign = |inputs: &mut Vec<PathBuf>,
                  map: &mut std::collections::HashMap<String, usize>,
                  asset: &AssetDto|
     -> CommandResult<usize> {
        if let Some(index) = map.get(&asset.id) {
            return Ok(*index);
        }
        let source = asset_path(scope, asset)?;
        if !source.is_file() {
            return Err(CommandError::io(format!(
                "the media for asset {} is missing at {}; relink it before exporting",
                asset.id,
                source.display()
            )));
        }
        let index = inputs.len();
        inputs.push(source);
        map.insert(asset.id.clone(), index);
        Ok(index)
    };

    let mut video: Vec<VideoGraphClip> = Vec::with_capacity(video_selection.len());
    for selected in &video_selection {
        let input_index = assign(&mut inputs, &mut input_index_by_asset, selected.asset)?;
        let transform = transform_properties(&selected.clip.properties);
        let crop = crop_properties(&selected.clip.properties);
        let (speed_num, speed_den) = store::clip_speed(selected.clip);
        video.push(VideoGraphClip {
            input_index,
            track_sort_order: selected.track.sort_order,
            clip_id: selected.clip.id.clone(),
            start_frame: selected.clip.start_frame,
            source_in_frame: selected.clip.source_in_frame,
            duration_frames: selected.clip.duration_frames,
            speed_num,
            speed_den,
            crop_top: crop.top,
            crop_right: crop.right,
            crop_bottom: crop.bottom,
            crop_left: crop.left,
            rotation: transform.rotation,
            scale: transform.scale,
            flip_x: transform.flip_x,
            flip_y: transform.flip_y,
            opacity: transform.opacity,
            position_x: transform.x,
            position_y: transform.y,
        });
    }

    let mut audio: Vec<AudioGraphClip> = Vec::with_capacity(audio_selection.len());
    for selected in &audio_selection {
        let input_index = assign(&mut inputs, &mut input_index_by_asset, selected.asset)?;
        let values = audio_properties(&selected.clip.properties);
        let (speed_num, speed_den) = store::clip_speed(selected.clip);
        audio.push(AudioGraphClip {
            input_index,
            track_sort_order: selected.track.sort_order,
            clip_id: selected.clip.id.clone(),
            start_frame: selected.clip.start_frame,
            source_in_frame: selected.clip.source_in_frame,
            duration_frames: selected.clip.duration_frames,
            speed_num,
            speed_den,
            // The track fader and the clip gain are independent contributions.
            gain_db: values.gain_db + selected.track.volume_db,
            fade_in_frames: values.fade_in_frames,
            fade_out_frames: values.fade_out_frames,
        });
    }

    let _ = preset;
    Ok(RenderPlan {
        inputs,
        video,
        audio,
        duration_frames,
        sequence_fps: sequence.fps,
    })
}

/// `render_status`.
#[tauri::command]
pub fn render_status(
    state: State<'_, AppState>,
    request: RenderStatusRequest,
) -> CommandResult<RenderStatusResponse> {
    let (_root, _scope) = super::workspace::scope_for_request(&state, &request.workspace_path)?;
    if request.export_job_id.trim().is_empty() {
        return Err(CommandError::validation("exportJobId must not be empty"));
    }
    let row = state
        .with_db(|connection| store::find_export_job(connection, &request.export_job_id))?
        .ok_or_else(|| {
            CommandError::validation(format!("unknown export job {}", request.export_job_id))
        })?;

    let status = RenderStatus::parse(&row.status).unwrap_or(RenderStatus::Queued);
    let log_tail = row
        .log_path
        .as_deref()
        .map(|path| read_log_tail(Path::new(path), 20))
        .unwrap_or_default();

    Ok(RenderStatusResponse {
        export_job_id: row.id,
        status,
        progress: row.progress.clamp(0.0, 1.0),
        rendered_frames: row.rendered_frames,
        total_frames: row.total_frames,
        log_tail,
        output_path: row.output_path,
        errors: row.errors,
    })
}

/// `render_cancel`.
///
/// Signals the worker first (so it can clean up its temp file and mark the row), then
/// writes the terminal state itself if the worker is not around to do it — a cancel must
/// never leave a job looking like it is still rendering.
#[tauri::command]
pub fn render_cancel(
    state: State<'_, AppState>,
    request: RenderCancelRequest,
) -> CommandResult<()> {
    if request.export_job_id.trim().is_empty() {
        return Err(CommandError::validation("exportJobId must not be empty"));
    }
    let row = state
        .with_db(|connection| store::find_export_job(connection, &request.export_job_id))?
        .ok_or_else(|| {
            CommandError::validation(format!("unknown export job {}", request.export_job_id))
        })?;

    if let Some(handle) = state.render_handle(&request.export_job_id) {
        handle.request_cancel();
    }
    // Give the worker a moment to observe the flag and tidy up its temp file.
    std::thread::sleep(std::time::Duration::from_millis(150));
    if state.render_handle(&request.export_job_id).is_some() {
        state.unregister_render(&request.export_job_id);
    }

    if RenderStatus::parse(&row.status)
        .map(RenderStatus::is_terminal)
        .unwrap_or(false)
    {
        return Ok(());
    }
    let mut cancelled = row;
    cancelled.status = RenderStatus::Canceled.as_str().to_string();
    cancelled.updated_at = crate::db::migrate::now_iso8601();
    state.with_db(|connection| store::update_export_job(connection, &cancelled))?;
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct TransformValues {
    x: f64,
    y: f64,
    rotation: f64,
    opacity: f64,
    scale: f64,
    flip_x: bool,
    flip_y: bool,
}

impl Default for TransformValues {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            rotation: 0.0,
            // Identity for the transform, matching `ClipProperties`' schema defaults: scale
            // 1 and no mirroring, so a clip with a partial `transform` object renders
            // unchanged rather than collapsing to zero size.
            scale: 1.0,
            flip_x: false,
            flip_y: false,
            opacity: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct CropValues {
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

#[derive(Debug, Clone, Copy)]
struct AudioValues {
    gain_db: f64,
    fade_in_frames: i64,
    fade_out_frames: i64,
    enabled: bool,
}

impl Default for AudioValues {
    fn default() -> Self {
        Self {
            gain_db: 0.0,
            fade_in_frames: 0,
            fade_out_frames: 0,
            enabled: true,
        }
    }
}

fn read_f64(value: &serde_json::Value, key: &str, fallback: f64) -> f64 {
    value
        .get(key)
        .and_then(|value| value.as_f64())
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn read_i64(value: &serde_json::Value, key: &str, fallback: i64) -> i64 {
    value
        .get(key)
        .and_then(|value| value.as_i64())
        .unwrap_or(fallback)
}

fn read_bool(value: &serde_json::Value, key: &str, fallback: bool) -> bool {
    value
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(fallback)
}

/// Read `properties.transform`, clamping to the schema's documented ranges.
fn transform_properties(properties: &serde_json::Value) -> TransformValues {
    let transform = properties
        .get("transform")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    TransformValues {
        x: read_f64(&transform, "x", 0.0),
        y: read_f64(&transform, "y", 0.0),
        rotation: read_f64(&transform, "rotation", 0.0),
        // Clamped exactly as the schema does, so a hand-edited manifest cannot produce
        // `scale=iw*0:ih*0`, which FFmpeg rejects outright.
        scale: read_f64(&transform, "scale", 1.0).clamp(0.01, 20.0),
        flip_x: read_bool(&transform, "flipX", false),
        flip_y: read_bool(&transform, "flipY", false),
        opacity: read_f64(&transform, "opacity", 1.0).clamp(0.0, 1.0),
    }
}

/// Read `properties.crop` (source-normalized fractions), clamped to `[0, 1]`.
fn crop_properties(properties: &serde_json::Value) -> CropValues {
    let crop = properties
        .get("crop")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    CropValues {
        top: read_f64(&crop, "top", 0.0).clamp(0.0, 1.0),
        right: read_f64(&crop, "right", 0.0).clamp(0.0, 1.0),
        bottom: read_f64(&crop, "bottom", 0.0).clamp(0.0, 1.0),
        left: read_f64(&crop, "left", 0.0).clamp(0.0, 1.0),
    }
}

/// Read `properties.audio`, clamping gain to the schema's `[-96, 24]` dB range.
fn audio_properties(properties: &serde_json::Value) -> AudioValues {
    let audio = properties
        .get("audio")
        .cloned()
        .unwrap_or(serde_json::json!({}));
    AudioValues {
        gain_db: read_f64(&audio, "gainDb", 0.0).clamp(-96.0, 24.0),
        fade_in_frames: read_i64(&audio, "fadeInFrames", 0).max(0),
        fade_out_frames: read_i64(&audio, "fadeOutFrames", 0).max(0),
        enabled: read_bool(&audio, "enabled", true),
    }
}

/// Last `count` non-empty lines of a render log.
pub fn read_log_tail(path: &Path, count: usize) -> Vec<String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    media::tail_lines(&text, count)
}

/// Extension point for `asset.hasAudioStream()`, which lives on the media probe.
trait HasAudioStream {
    fn has_audio_stream(&self) -> bool;
}

impl HasAudioStream for AssetDto {
    fn has_audio_stream(&self) -> bool {
        // A video asset with no probe result is assumed to carry audio: extracting a
        // missing stream is a validation error in FFmpeg, but silently dropping the
        // audio of an unprobed file would be a wrong render.
        match self.media_type.as_str() {
            "audio" => true,
            "image" | "subtitle" => false,
            _ => self
                .probe
                .as_ref()
                .and_then(|probe| probe.get("hasAudio"))
                .and_then(|value| value.as_bool())
                .unwrap_or(true),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transform_defaults_match_the_schema() {
        let values = transform_properties(&serde_json::json!({}));
        assert_eq!(values.x, 0.0);
        assert_eq!(values.y, 0.0);
        assert_eq!(values.rotation, 0.0);
        assert_eq!(values.opacity, 1.0);

        let values = transform_properties(&serde_json::json!({
            "transform": { "x": 10.5, "y": -3.25, "rotation": 45.0, "opacity": 0.5 }
        }));
        assert_eq!(values.x, 10.5);
        assert_eq!(values.y, -3.25);
        assert_eq!(values.rotation, 45.0);
        assert_eq!(values.opacity, 0.5);
    }

    #[test]
    fn out_of_range_properties_are_clamped_not_trusted() {
        // Opacity outside [0, 1] would produce an alpha FFmpeg cannot use.
        let values = transform_properties(&serde_json::json!({ "transform": { "opacity": 4.0 } }));
        assert_eq!(values.opacity, 1.0);
        let values = transform_properties(&serde_json::json!({ "transform": { "opacity": -2.0 } }));
        assert_eq!(values.opacity, 0.0);

        // Crop fractions outside [0, 1] would produce a negative crop size.
        let crop = crop_properties(&serde_json::json!({ "crop": { "left": 2.0, "top": -1.0 } }));
        assert_eq!(crop.left, 1.0);
        assert_eq!(crop.top, 0.0);

        // Gain outside the schema range is clamped to the documented window.
        let audio = audio_properties(&serde_json::json!({ "audio": { "gainDb": 1000.0 } }));
        assert_eq!(audio.gain_db, 24.0);

        // Non-finite JSON numbers are not expressible, but a string is: fall back.
        let values = transform_properties(&serde_json::json!({ "transform": { "x": "12" } }));
        assert_eq!(values.x, 0.0);
    }

    #[test]
    fn audio_defaults_are_an_unmodified_enabled_clip() {
        let values = audio_properties(&serde_json::json!({}));
        assert_eq!(values.gain_db, 0.0);
        assert_eq!(values.fade_in_frames, 0);
        assert_eq!(values.fade_out_frames, 0);
        assert!(values.enabled);

        let values = audio_properties(&serde_json::json!({
            "audio": { "gainDb": -6.0, "fadeInFrames": 15, "fadeOutFrames": -5, "enabled": false }
        }));
        assert_eq!(values.gain_db, -6.0);
        assert_eq!(values.fade_in_frames, 15);
        assert_eq!(values.fade_out_frames, 0, "negative fades clamp to zero");
        assert!(!values.enabled);
    }

    #[test]
    fn audio_stream_detection_prefers_the_probe() {
        let mut asset = store::test_support::fixture_asset("ast_1");
        // No probe hint: assume a video file carries audio (dropping it silently would be
        // a wrong render).
        assert!(asset.has_audio_stream());
        asset.probe = Some(serde_json::json!({ "hasAudio": false }));
        assert!(!asset.has_audio_stream());
        asset.media_type = "audio".into();
        assert!(asset.has_audio_stream(), "an audio asset always has audio");
        asset.media_type = "image".into();
        asset.probe = Some(serde_json::json!({ "hasAudio": true }));
        assert!(!asset.has_audio_stream(), "an image never has audio");
    }

    #[test]
    fn log_tail_is_empty_for_a_missing_file() {
        assert!(read_log_tail(Path::new("/definitely/not/here.log"), 5).is_empty());
        let directory =
            std::env::temp_dir().join(format!("creativelab-log-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("render.log");
        std::fs::write(&path, "a\nb\n\nc\nd\n").unwrap();
        assert_eq!(read_log_tail(&path, 2), vec!["c", "d"]);
        let _ = std::fs::remove_dir_all(&directory);
    }
}
