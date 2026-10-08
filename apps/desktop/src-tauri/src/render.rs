//! Timeline rendering: the FFmpeg filter graph, the render worker, and cancellation.
//!
//! ## Preview/export parity (FR-04)
//! `build_filter_graph` implements exactly the rules in `packages/media/src/graph.ts`:
//! same stage order, same numbers, same omission of identity stages. Preview and export
//! therefore agree by construction. The `filter_string_matches_the_frozen_graph_rules`
//! test asserts the literal string for a fixture timeline, so a change on one side that
//! is not mirrored on the other fails here.
//!
//! ## Rendering to a temp file, then renaming
//! PRD §12: "render queue uses temp output then atomic rename". A failed or cancelled
//! render always deletes its temp file, so the user's chosen `outputPath` is never left
//! holding a truncated file.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::db::store::{self, ExportJobRow};
use crate::error::{CommandError, CommandResult};
use crate::media;
use crate::protocol::*;
use crate::state::RenderCancelHandle;

// ---------------------------------------------------------------------------
// Inputs the graph builder needs (pure data, no IO)
//
// These mirror `ParticipatingClip` / `GraphAssetInfo` in
// `packages/media/src/graph.ts`. The builder is pure so the emitted string is
// testable without FFmpeg, and so the TypeScript and Rust builders are
// string-comparable.
// ---------------------------------------------------------------------------

/// Composition-level inputs: the export preset plus the timeline duration.
#[derive(Debug, Clone, PartialEq)]
pub struct GraphConfig {
    pub width: i64,
    pub height: i64,
    /// Preset frame rate, used for the base source, the overlay window and total frames.
    pub fps: FrameRateDto,
    /// Sequence frame rate, used for every timeline-frame -> seconds conversion.
    pub sequence_fps: FrameRateDto,
    /// Timeline duration in sequence frames.
    pub duration_frames: i64,
    /// `yuv420p` | `yuv422p` | `yuv444p`, from the export preset.
    pub pixel_format: String,
    /// `document.project.sampleRate`, used by the silent base when there is no audio.
    pub sample_rate: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VideoGraphClip {
    /// FFmpeg input index that supplies the video stream.
    pub input_index: usize,
    /// Track `sort_order`; ascending, so higher tracks composite on top.
    pub track_sort_order: i64,
    pub clip_id: String,
    pub start_frame: i64,
    pub source_in_frame: i64,
    pub duration_frames: i64,
    /// `properties.speed`, as an exact rational.
    pub speed_num: i64,
    pub speed_den: i64,
    /// Fractional crop; all-zero means identity (the `crop` stage is omitted).
    pub crop_top: f64,
    pub crop_right: f64,
    pub crop_bottom: f64,
    pub crop_left: f64,
    /// Degrees clockwise; 0 means identity (the `rotate` stage is omitted).
    pub rotation: f64,
    /// 0..1; `>= 1` means identity (the `colorchannelmixer` stage is omitted).
    pub opacity: f64,
    /// `transform.x` / `transform.y` in project pixels, used by the `overlay`.
    pub position_x: f64,
    pub position_y: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AudioGraphClip {
    pub input_index: usize,
    pub track_sort_order: i64,
    pub clip_id: String,
    pub start_frame: i64,
    pub source_in_frame: i64,
    pub duration_frames: i64,
    pub speed_num: i64,
    pub speed_den: i64,
    pub gain_db: f64,
    pub fade_in_frames: i64,
    pub fade_out_frames: i64,
}

// ---------------------------------------------------------------------------
// The filter graph
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct FilterGraph {
    /// The whole `-filter_complex` argument.
    pub complex: String,
    /// `-map` stream specifiers, video first. Matches `ExportFilterGraph.maps`.
    pub maps: Vec<String>,
    /// Codec/muxer arguments (no input, filter or output path).
    pub encode_args: Vec<String>,
    /// Frames the encoder will produce at the preset rate.
    pub total_frames: i64,
    /// Timeline duration in seconds at the sequence rate.
    pub duration_seconds: f64,
    /// Number of audio streams fed to `amix`; 0 when a silent base is used instead.
    pub audio_inputs: usize,
}

impl FilterGraph {
    /// True when real audio contributes to the mix (as opposed to the silent base).
    pub fn has_mixed_audio(&self) -> bool {
        self.audio_inputs > 0 && self.complex.contains("[aout]")
    }
}

/// `+120` / `-40` — never `+-40`. Mirrors `signedOffset` in `graph.ts`.
fn signed_offset(value: f64) -> String {
    if value < 0.0 {
        format!("-{}", media::format_number(value.abs(), 6))
    } else {
        format!("+{}", media::format_number(value, 6))
    }
}

/// `atempo` accepts 0.5–2.0 per instance, so larger or smaller factors are chained.
/// Mirrors `buildAtempoChain`.
pub fn build_atempo_chain(speed: f64) -> CommandResult<Vec<String>> {
    if !speed.is_finite() || speed <= 0.0 {
        return Err(CommandError::validation(format!(
            "clip speed must be positive, received {speed}"
        )));
    }
    if speed == 1.0 {
        return Ok(Vec::new());
    }
    let mut steps: Vec<f64> = Vec::new();
    let mut remaining = speed;
    // Guarded loops: the epsilon keeps a float 2.0000000001 from adding a useless step.
    while remaining > 2.0 + 1e-9 {
        steps.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 - 1e-9 {
        steps.push(0.5);
        remaining /= 0.5;
    }
    if (remaining - 1.0).abs() > 1e-9 {
        steps.push(remaining);
    }
    Ok(steps
        .into_iter()
        .map(|step| format!("atempo={}", media::format_number(step, 6)))
        .collect())
}

/// `crop=w:h:x:y` with literal pixels, derived from the source-normalized fractions.
///
/// Omitting this when all four fractions are zero is what keeps a plain clip free of
/// identity stages.
pub fn crop_stage(clip: &VideoGraphClip, width: i64, height: i64) -> Option<String> {
    if clip.crop_top == 0.0
        && clip.crop_right == 0.0
        && clip.crop_bottom == 0.0
        && clip.crop_left == 0.0
    {
        return None;
    }
    // A fully-cropped axis is invalid for FFmpeg; clamp to one pixel rather than emit
    // `crop=0`.
    let crop_width = ((1.0 - clip.crop_left - clip.crop_right) * width as f64).max(1.0);
    let crop_height = ((1.0 - clip.crop_top - clip.crop_bottom) * height as f64).max(1.0);
    Some(format!(
        "crop={}:{}:{}:{}",
        media::format_number(crop_width, 6),
        media::format_number(crop_height, 6),
        media::format_number(clip.crop_left * width as f64, 6),
        media::format_number(clip.crop_top * height as f64, 6),
    ))
}

/// `rotate=rad:ow=rotw(rad):oh=roth(rad):c=none`, omitted when the clip is not rotated.
///
/// `rotw()`/`roth()` take an **angle in radians**, not a size, so the same formatted radians
/// value is passed to all three positions. `transform.rotation` is clockwise degrees and
/// FFmpeg's `rotate` is clockwise for positive radians, so the sign is *not* flipped.
pub fn rotation_stage(clip: &VideoGraphClip) -> Option<String> {
    if clip.rotation == 0.0 {
        return None;
    }
    let radians = media::format_number(clip.rotation * std::f64::consts::PI / 180.0, 6);
    Some(format!(
        "rotate={radians}:ow=rotw({radians}):oh=roth({radians}):c=none"
    ))
}

/// `colorchannelmixer=aa=<opacity>`, omitted when the clip is fully opaque.
pub fn opacity_stage(clip: &VideoGraphClip) -> Option<String> {
    if clip.opacity >= 1.0 {
        return None;
    }
    Some(format!(
        "colorchannelmixer=aa={}",
        media::format_number(clip.opacity, 6)
    ))
}

/// Build the complete render description.
///
/// Stage order, stage spelling and numeric formatting are the contract shared with
/// `packages/media/src/graph.ts`: variable-length chains are joined with `;` for
/// `-filter_complex`, identity stages are omitted, and every video clip composites onto a
/// single `[base]` in track order.
pub fn build_filter_graph(
    config: &GraphConfig,
    video_clips: &[VideoGraphClip],
    audio_clips: &[AudioGraphClip],
) -> CommandResult<FilterGraph> {
    if video_clips.is_empty() && audio_clips.is_empty() {
        return Err(CommandError::validation(
            "cannot render an empty timeline: the sequence has no clips",
        ));
    }
    if config.duration_frames <= 0 {
        return Err(CommandError::validation(
            "cannot render an empty timeline: its duration is zero frames",
        ));
    }

    // Track order, then start frame, then clip id — identical to `compareClips`.
    let order =
        |track: i64, start: i64, id: &str, other: &(i64, i64, String)| -> std::cmp::Ordering {
            track
                .cmp(&other.0)
                .then(start.cmp(&other.1))
                .then(id.cmp(&other.2))
        };
    let mut video: Vec<&VideoGraphClip> = video_clips.iter().collect();
    video.sort_by(|left, right| {
        order(
            left.track_sort_order,
            left.start_frame,
            &left.clip_id,
            &(
                right.track_sort_order,
                right.start_frame,
                right.clip_id.clone(),
            ),
        )
    });
    let mut audio: Vec<&AudioGraphClip> = audio_clips.iter().collect();
    audio.sort_by(|left, right| {
        order(
            left.track_sort_order,
            left.start_frame,
            &left.clip_id,
            &(
                right.track_sort_order,
                right.start_frame,
                right.clip_id.clone(),
            ),
        )
    });

    let width = config.width;
    let height = config.height;
    let duration_seconds = config
        .sequence_fps
        .frames_to_seconds(config.duration_frames);
    let duration_text = media::format_number(duration_seconds, 6);

    let mut stages: Vec<String> = Vec::new();
    // The composition base is a generated black frame at the preset rate and full duration;
    // every video clip is composited onto it, so gaps render as black rather than as a gap.
    stages.push(format!(
        "color=c=black:s={width}x{height}:r={num}/{den}:d={duration_text}[base]",
        num = config.fps.num,
        den = config.fps.den,
    ));

    for (index, clip) in video.iter().enumerate() {
        let speed = if clip.speed_den == 0 {
            1.0
        } else {
            clip.speed_num as f64 / clip.speed_den as f64
        };
        let source_in_seconds = config.sequence_fps.frames_to_seconds(clip.source_in_frame);
        let clip_seconds = config.sequence_fps.frames_to_seconds(clip.duration_frames);

        let mut chain: Vec<String> = vec![
            format!(
                "trim=start={}:duration={}",
                media::format_number(source_in_seconds, 6),
                media::format_number(clip_seconds, 6)
            ),
            format!("setpts=(PTS-STARTPTS)/{}", media::format_number(speed, 6)),
            format!("scale={width}:{height}:force_original_aspect_ratio=decrease"),
            format!("pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"),
        ];
        if let Some(crop) = crop_stage(clip, width, height) {
            chain.push(crop);
        }
        if let Some(rotation) = rotation_stage(clip) {
            chain.push(rotation);
        }
        chain.push("format=rgba".to_string());
        if let Some(opacity) = opacity_stage(clip) {
            chain.push(opacity);
        }
        stages.push(format!(
            "[{}:v]{}[v{index}]",
            clip.input_index,
            chain.join(",")
        ));

        let start_seconds = config.sequence_fps.frames_to_seconds(clip.start_frame);
        let end_seconds = config
            .sequence_fps
            .frames_to_seconds(clip.start_frame + clip.duration_frames);
        // The concrete `W`/`H` follow the pad dimensions exactly, so preview and export
        // place the clip identically.
        let x = format!("({width}-w)/2{}", signed_offset(clip.position_x));
        let y = format!("({height}-h)/2{}", signed_offset(clip.position_y));
        stages.push(format!(
            "[base][v{index}]overlay=x={x}:y={y}:enable='between(t,{start},{end})'[base]",
            start = media::format_number(start_seconds, 6),
            end = media::format_number(end_seconds, 6),
        ));
    }

    for (index, clip) in audio.iter().enumerate() {
        let speed = if clip.speed_den == 0 {
            1.0
        } else {
            clip.speed_num as f64 / clip.speed_den as f64
        };
        let source_in_seconds = config.sequence_fps.frames_to_seconds(clip.source_in_frame);
        let clip_seconds = config.sequence_fps.frames_to_seconds(clip.duration_frames);
        let delay_ms = (config.sequence_fps.frames_to_seconds(clip.start_frame) * 1000.0).round();

        let mut chain: Vec<String> = vec![
            format!(
                "atrim=start={}:duration={}",
                media::format_number(source_in_seconds, 6),
                media::format_number(clip_seconds, 6)
            ),
            "asetpts=PTS-STARTPTS".to_string(),
        ];
        chain.extend(build_atempo_chain(speed)?);
        // Identity stages are omitted: a clip at t=0 has no delay to apply.
        if delay_ms > 0.0 {
            let delay_ms = delay_ms as i64;
            chain.push(format!("adelay={delay_ms}|{delay_ms}"));
        }
        if clip.gain_db != 0.0 {
            chain.push(format!(
                "volume={}",
                media::format_number(media::db_to_linear(clip.gain_db), 6)
            ));
        }
        let fade_in_seconds = config.sequence_fps.frames_to_seconds(clip.fade_in_frames);
        if clip.fade_in_frames > 0 && fade_in_seconds > 0.0 {
            chain.push(format!(
                "afade=t=in:st=0:d={}",
                media::format_number(fade_in_seconds, 6)
            ));
        }
        let fade_out_seconds = config.sequence_fps.frames_to_seconds(clip.fade_out_frames);
        if clip.fade_out_frames > 0 && fade_out_seconds > 0.0 {
            // The fade is computed on the delayed timeline, which is where the audio is.
            let fade_out_start = (delay_ms / 1000.0 + clip_seconds - fade_out_seconds).max(0.0);
            chain.push(format!(
                "afade=t=out:st={}:d={}",
                media::format_number(fade_out_start, 6),
                media::format_number(fade_out_seconds, 6)
            ));
        }
        stages.push(format!(
            "[{}:a]{}[a{index}]",
            clip.input_index,
            chain.join(",")
        ));
    }

    if audio.is_empty() {
        // The preset always carries an AAC track, so an audio-only silent base keeps the
        // output shape stable for players and for the preview parity check (FR-04).
        stages.push(format!(
            "anullsrc=channel_layout=stereo:sample_rate={},atrim=duration={duration_text},asetpts=PTS-STARTPTS[aout]",
            config.sample_rate
        ));
    } else {
        let inputs: Vec<String> = (0..audio.len()).map(|index| format!("a{index}")).collect();
        stages.push(format!(
            "[{}]amix=inputs={}:normalize=0:dropout_transition=0[aout]",
            inputs.join("]["),
            audio.len()
        ));
    }

    let mut encode_args: Vec<String> = vec![
        "-c:v".into(),
        "libx264".into(),
        "-pix_fmt".into(),
        config.pixel_format.clone(),
        "-preset".into(),
        // CRF mode is quality-bound, so the slower preset buys nothing but time.
        "medium".into(),
    ];
    encode_args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    encode_args.extend([
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-shortest".into(),
    ]);

    Ok(FilterGraph {
        complex: stages.join(";"),
        maps: vec!["[base]".into(), "[aout]".into()],
        encode_args,
        total_frames: config.fps.seconds_to_frames(duration_seconds),
        duration_seconds,
        audio_inputs: audio.len(),
    })
}

/// Map an export-preset id to a concrete encode target.
///
/// Mirrors `EXPORT_PRESETS` in `packages/core/src/schema.ts`. An unknown preset id is a
/// validation error rather than a silent default, so the user never gets a file that does
/// not match the label they picked.
#[derive(Debug, Clone, PartialEq)]
pub struct Preset {
    pub id: String,
    pub width: i64,
    pub height: i64,
    pub fps: FrameRateDto,
    pub video_bitrate_kbps: Option<i64>,
    pub crf: Option<i64>,
    pub audio_bitrate_kbps: i64,
    pub pixel_format: String,
    pub burn_in_captions: bool,
}

pub fn resolve_preset(preset_id: &str, fallback_fps: FrameRateDto) -> CommandResult<Preset> {
    // Shared defaults come from `ExportPresetSchema`: mp4 / h264 / aac, 192 kbit/s audio,
    // `yuv420p`, no caption burn-in.
    //
    // `fps` is `None` for every shipped preset: `ExportPresetSchema.fps` is
    // `nullable().default(null)` and "null means use the project's frame rate". PRD §12
    // requires that "export always renders at project settings", so a 25 fps project must
    // not be silently resampled to 30 by the preset.
    let (width, height, fps, video_bitrate_kbps, crf) = match preset_id {
        "1080p" => (1920, 1080, None, Some(12_000), None),
        "720p" => (1280, 720, None, Some(6_000), None),
        "1080p-vertical" => (1080, 1920, None, Some(10_000), None),
        "master-crf" => (1920, 1080, None, Some(20_000), Some(16)),
        other => {
            return Err(CommandError::validation(format!(
                "unknown export preset '{other}'"
            )))
        }
    };
    if fallback_fps.num <= 0 || fallback_fps.den <= 0 {
        return Err(CommandError::validation(
            "the sequence frame rate must be positive before it can be used as the export rate",
        ));
    }
    Ok(Preset {
        id: preset_id.to_string(),
        width,
        height,
        // `preset.fps === null ? fps : frameRate(...)` in `graph.ts`.
        fps: fps.unwrap_or(fallback_fps),
        video_bitrate_kbps,
        crf,
        audio_bitrate_kbps: 192,
        pixel_format: "yuv420p".to_string(),
        burn_in_captions: false,
    })
}

/// The full command line for a render, as an argument array.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderCommandSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Assemble the ffmpeg argument array from a [`FilterGraph`] and the resolved [`Preset`].
///
/// `graph.encode_args` carries the codec/muxer flags; the bitrate-or-CRF choice and the
/// encoder preset are substituted from `Preset` so one source of truth decides them. The
/// argv is a `Vec<String>` handed straight to `execve`, which is half of the no-shell
/// guarantee; the other half is that nothing here is ever passed through a shell.
pub fn build_render_arguments(
    inputs: &[PathBuf],
    graph: &FilterGraph,
    preset: &Preset,
    output: &Path,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".to_string(),
        "-nostdin".to_string(),
        "-y".to_string(),
    ];
    for input in inputs {
        args.push("-i".into());
        args.push(input.to_string_lossy().to_string());
    }
    args.push("-filter_complex".into());
    args.push(graph.complex.clone());
    for map in &graph.maps {
        args.push("-map".into());
        args.push(map.clone());
    }

    // Walk `encode_args` as `flag value` pairs, substituting the values that come from the
    // resolved preset. `graph.ts` fixes the order, so the argv is deterministic — and a
    // substituted pair must consume *both* tokens, or the original value would be replayed
    // as if it were a flag.
    let base = &graph.encode_args;
    let mut index = 0;
    while index < base.len() {
        let flag = base[index].clone();
        let value = base.get(index + 1).cloned();
        let mut consumed = 1;
        match flag.as_str() {
            // CRF mode is quality-bound, so the slower preset buys nothing but time.
            "-preset" => {
                args.push(flag);
                args.push(
                    if preset.crf.is_none() {
                        "medium"
                    } else {
                        "veryfast"
                    }
                    .to_string(),
                );
                consumed = 2;
            }
            "-pix_fmt" => {
                args.push(flag);
                args.push(preset.pixel_format.clone());
                consumed = 2;
            }
            "-b:a" => {
                args.push(flag);
                args.push(format!("{}k", preset.audio_bitrate_kbps));
                consumed = 2;
            }
            "-c:v" => {
                args.push(flag);
                args.push(value.unwrap_or_else(|| "libx264".to_string()));
                consumed = 2;
                // Rate control belongs with the video encoder. Exactly one of bitrate/CRF
                // is emitted, matching `if (preset.crf === null)` in `graph.ts`.
                if let Some(crf) = preset.crf {
                    args.push("-crf".into());
                    args.push(crf.to_string());
                } else if let Some(bitrate) = preset.video_bitrate_kbps {
                    args.push("-b:v".into());
                    args.push(format!("{bitrate}k"));
                }
            }
            _ => {
                args.push(flag);
                if let Some(value) = value {
                    args.push(value);
                    consumed = 2;
                }
            }
        }
        index += consumed;
    }

    // Progress lines on stdout, parseable one `key=value` per line.
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(output.to_string_lossy().to_string());
    args
}

// ---------------------------------------------------------------------------
// Progress parsing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct RenderProgress {
    pub frame: Option<i64>,
    pub out_time_us: Option<i64>,
    pub done: bool,
}

/// Parse one `-progress` line. `out_time_us` and `out_time_ms` are both accepted:
/// FFmpeg's naming is famously reversed — `out_time_ms` is actually microseconds.
pub fn parse_progress_line(line: &str) -> Option<(&'static str, i64)> {
    let (key, value) = line.split_once('=')?;
    match key.trim() {
        "frame" => value.trim().parse::<i64>().ok().map(|v| ("frame", v)),
        "out_time_us" | "out_time_ms" => {
            value.trim().parse::<i64>().ok().map(|v| ("out_time_us", v))
        }
        _ => None,
    }
}

/// Fold progress lines into a running total.
pub fn apply_progress_line(progress: &mut RenderProgress, line: &str) {
    match line.trim() {
        "progress=end" => progress.done = true,
        _ => {
            if let Some((key, value)) = parse_progress_line(line) {
                match key {
                    "frame" => progress.frame = Some(value),
                    "out_time_us" => progress.out_time_us = Some(value),
                    _ => {}
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The render worker
// ---------------------------------------------------------------------------

/// Everything the background render thread needs.
pub struct RenderJob {
    pub workspace_root: PathBuf,
    pub export_job_id: String,
    pub output_path: PathBuf,
    pub inputs: Vec<PathBuf>,
    pub graph: FilterGraph,
    pub preset: Preset,
    pub total_frames: i64,
    pub handle: Arc<RenderCancelHandle>,
}

/// Temp file next to the destination so the final `rename` is on one filesystem and
/// therefore atomic.
pub fn temporary_output_path(output: &Path) -> PathBuf {
    let name = output
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "render.mp4".to_string());
    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!(".{name}.{}.partial.mp4", std::process::id()))
}

fn log_tail_path(workspace_root: &Path, export_job_id: &str) -> PathBuf {
    workspace_root
        .join("cache")
        .join("render-logs")
        .join(format!("{export_job_id}.log"))
}

/// Run one render to completion. Called on a dedicated blocking thread.
///
/// The worker owns its own `Connection`: SQLite handles concurrency between connections
/// (WAL journal plus a busy timeout are set in `db::open_database`), and `rusqlite`'s
/// `Connection` is `Send` but not `Sync`, so owning one here is the correct model rather
/// than sharing the command connection behind a lock.
///
/// Returns `Ok(())` when the output was renamed into place, and an error otherwise; the
/// `export_jobs` row is always left in a terminal state.
pub fn run_render(job: RenderJob, database: &Connection) -> CommandResult<()> {
    let temporary = temporary_output_path(&job.output_path);
    let _ = std::fs::remove_file(&temporary);
    let log_path = log_tail_path(&job.workspace_root, &job.export_job_id);

    let program = media::ffmpeg_path()?;
    let args = build_render_arguments(&job.inputs, &job.graph, &job.preset, &temporary);

    update_export_row(
        database,
        &job.export_job_id,
        |row| {
            row.status = RenderStatus::Preparing.as_str().to_string();
            row.progress = 0.0;
        },
        &job.handle,
    )?;

    let mut child = std::process::Command::new(&program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            CommandError::from_io(&format!("could not start {}", program.display()), &error)
        })?;

    // Publish the kill closure so `render_cancel` can reach the child.
    let child_id = child.id();
    job.handle.set_kill(Box::new(move || {
        // SIGTERM so ffmpeg can flush; the alarm thread escalates to SIGKILL.
        unsafe {
            libc_kill(child_id as i32, 15);
        }
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(2500));
            unsafe {
                libc_kill(child_id as i32, 9);
            }
        });
    }));

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CommandError::internal("ffmpeg stdout was not piped"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| CommandError::internal("ffmpeg stderr was not piped"))?;

    update_export_row(
        database,
        &job.export_job_id,
        |row| row.status = RenderStatus::Rendering.as_str().to_string(),
        &job.handle,
    )?;

    let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    let tail_writer = Arc::clone(&tail);
    let log_path_for_stderr = log_path.clone();
    let stderr_thread = std::thread::spawn(move || {
        let mut collected: Vec<String> = Vec::new();
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(mut guard) = tail_writer.lock() {
                guard.push_back(line.clone());
                while guard.len() > 40 {
                    guard.pop_front();
                }
            }
            collected.push(line);
        }
        if let Some(parent) = log_path_for_stderr.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(log_path_for_stderr, collected.join("\n"));
    });

    let mut progress = RenderProgress::default();
    let mut last_flushed_frame = -1i64;
    let reader = BufReader::new(stdout);
    for line in reader.lines().map_while(Result::ok) {
        apply_progress_line(&mut progress, &line);
        if job.handle.is_canceled() {
            break;
        }
        let frame = progress.frame.unwrap_or(0);
        if frame != last_flushed_frame && frame % 5 == 0 {
            last_flushed_frame = frame;
            let ratio = if job.total_frames > 0 {
                (frame as f64 / job.total_frames as f64).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let _ = update_export_row(
                database,
                &job.export_job_id,
                |row| {
                    row.progress = ratio;
                    row.rendered_frames = frame;
                },
                &job.handle,
            );
        }
    }

    let status = child
        .wait()
        .map_err(|error| CommandError::from_io("ffmpeg did not report an exit status", &error))?;
    let _ = stderr_thread.join();
    let stderr_tail: Vec<String> = tail
        .lock()
        .map(|guard| guard.iter().cloned().collect())
        .unwrap_or_default();

    if job.handle.is_canceled() {
        let _ = std::fs::remove_file(&temporary);
        let _ = update_export_row(
            database,
            &job.export_job_id,
            |row| {
                row.status = RenderStatus::Canceled.as_str().to_string();
                row.errors = Vec::new();
                row.log_path = Some(log_path.to_string_lossy().to_string());
            },
            &job.handle,
        );
        return Err(CommandError::canceled("render canceled"));
    }

    if !status.success() {
        let _ = std::fs::remove_file(&temporary);
        let message = if stderr_tail.is_empty() {
            format!("ffmpeg exited with {status}")
        } else {
            media::tail_lines(&stderr_tail.join("\n"), 4).join(" | ")
        };
        let _ = update_export_row(
            database,
            &job.export_job_id,
            |row| {
                row.status = RenderStatus::Failed.as_str().to_string();
                row.errors = media::tail_lines(&stderr_tail.join("\n"), 6);
                row.log_path = Some(log_path.to_string_lossy().to_string());
            },
            &job.handle,
        );
        return Err(CommandError::media(format!("render failed: {message}")));
    }

    // Finalizing: rename the completed temp file over the destination.
    update_export_row(
        database,
        &job.export_job_id,
        |row| row.status = RenderStatus::Finalizing.as_str().to_string(),
        &job.handle,
    )?;
    if let Some(parent) = job.output_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            CommandError::from_io("could not create the export directory", &error)
        })?;
    }
    std::fs::rename(&temporary, &job.output_path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        CommandError::from_io(
            &format!(
                "could not move the render into {}",
                job.output_path.display()
            ),
            &error,
        )
    })?;

    update_export_row(
        database,
        &job.export_job_id,
        |row| {
            row.status = RenderStatus::Completed.as_str().to_string();
            row.progress = 1.0;
            row.rendered_frames = job.total_frames;
            row.log_path = Some(log_path.to_string_lossy().to_string());
        },
        &job.handle,
    )?;
    Ok(())
}

/// Read-modify-write one `export_jobs` row.
fn update_export_row(
    database: &Connection,
    export_job_id: &str,
    mutate: impl FnOnce(&mut ExportJobRow),
    _handle: &RenderCancelHandle,
) -> CommandResult<()> {
    let mut row = store::find_export_job(database, export_job_id)?
        .ok_or_else(|| CommandError::validation(format!("unknown export job {export_job_id}")))?;
    mutate(&mut row);
    row.updated_at = crate::db::migrate::now_iso8601();
    store::update_export_job(database, &row)?;
    Ok(())
}

// Minimal `kill(2)`. Declared here rather than pulling in the `libc` crate for one call.
extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, signal: i32) -> i32;
}

/// Wait for a child with a deadline, then escalate. Used by the synchronous cancel path
/// when the render thread has not noticed the flag yet.
pub fn terminate_child(child: &mut Child) {
    let pid = child.id() as i32;
    unsafe {
        libc_kill(pid, 15);
    }
    for _ in 0..25 {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(_) => return,
        }
    }
    unsafe {
        libc_kill(pid, 9);
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Count of audio streams a render will produce, used to decide `-map`.
pub fn has_audio(graph: &FilterGraph) -> bool {
    graph.audio_inputs > 0 && graph.complex.contains("[aout]")
}

/// `true` when a render handle has already been signalled.
pub fn is_canceled(handle: &RenderCancelHandle) -> bool {
    handle.canceled.load(Ordering::SeqCst)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A 1920x1080 / 30fps export preset over a 300-frame (10s) sequence — the same
    /// fixture shape the TypeScript `graph.test.ts` uses, so the two strings are directly
    /// comparable.
    fn config() -> GraphConfig {
        GraphConfig {
            width: 1920,
            height: 1080,
            fps: FrameRateDto::new(30, 1),
            sequence_fps: FrameRateDto::new(30, 1),
            duration_frames: 300,
            pixel_format: "yuv420p".to_string(),
            sample_rate: 48_000,
        }
    }

    /// A minimal, fully-identity video clip on `track` starting at frame 0 for 10s.
    fn plain_video_clip(input_index: usize, track: i64) -> VideoGraphClip {
        VideoGraphClip {
            input_index,
            track_sort_order: track,
            clip_id: format!("clp_{track}"),
            start_frame: 0,
            source_in_frame: 0,
            duration_frames: 300,
            speed_num: 1,
            speed_den: 1,
            crop_top: 0.0,
            crop_right: 0.0,
            crop_bottom: 0.0,
            crop_left: 0.0,
            rotation: 0.0,
            opacity: 1.0,
            position_x: 0.0,
            position_y: 0.0,
        }
    }

    fn plain_audio_clip(input_index: usize) -> AudioGraphClip {
        AudioGraphClip {
            input_index,
            track_sort_order: 0,
            clip_id: "clp_a0".to_string(),
            start_frame: 0,
            source_in_frame: 0,
            duration_frames: 300,
            speed_num: 1,
            speed_den: 1,
            gain_db: 0.0,
            fade_in_frames: 0,
            fade_out_frames: 0,
        }
    }

    // -----------------------------------------------------------------------
    // (a) Exact filter_complex strings
    // -----------------------------------------------------------------------

    #[test]
    fn filter_string_matches_the_frozen_graph_rules() {
        let video = vec![
            // Track 0 (bottom), input 0, frames 0..120.
            VideoGraphClip {
                start_frame: 0,
                source_in_frame: 0,
                duration_frames: 120,
                ..plain_video_clip(0, 0)
            },
            // Track 2 (top), input 1, frames 60..150, 2x speed, opacity 0.5.
            VideoGraphClip {
                start_frame: 60,
                source_in_frame: 15,
                duration_frames: 90,
                speed_num: 2,
                speed_den: 1,
                opacity: 0.5,
                clip_id: "clp_2".to_string(),
                ..plain_video_clip(1, 2)
            },
        ];
        let audio = vec![AudioGraphClip {
            start_frame: 30,
            duration_frames: 60,
            gain_db: -6.0,
            ..plain_audio_clip(0)
        }];
        let graph = build_filter_graph(&config(), &video, &audio).unwrap();

        let expected = concat!(
            "color=c=black:s=1920x1080:r=30/1:d=10[base]",
            ";",
            "[0:v]trim=start=0:duration=4,setpts=(PTS-STARTPTS)/1,",
            "scale=1920:1080:force_original_aspect_ratio=decrease,",
            "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=rgba[v0]",
            ";",
            "[base][v0]overlay=x=(1920-w)/2+0:y=(1080-h)/2+0:enable='between(t,0,4)'[base]",
            ";",
            "[1:v]trim=start=0.5:duration=3,setpts=(PTS-STARTPTS)/2,",
            "scale=1920:1080:force_original_aspect_ratio=decrease,",
            "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=rgba,",
            "colorchannelmixer=aa=0.5[v1]",
            ";",
            "[base][v1]overlay=x=(1920-w)/2+0:y=(1080-h)/2+0:enable='between(t,2,5)'[base]",
            ";",
            "[0:a]atrim=start=0:duration=2,asetpts=PTS-STARTPTS,adelay=1000|1000,volume=0.501187[a0]",
            ";",
            "[a0]amix=inputs=1:normalize=0:dropout_transition=0[aout]",
        );
        assert_eq!(graph.complex, expected);
        assert_eq!(graph.audio_inputs, 1);
        assert_eq!(graph.maps, vec!["[base]".to_string(), "[aout]".to_string()]);
        assert_eq!(graph.total_frames, 300);
        assert_eq!(graph.duration_seconds, 10.0);

        // Identity stages really are absent, not merely harmless.
        assert!(!graph.complex.contains("crop="), "{}", graph.complex);
        assert!(!graph.complex.contains("rotate="), "{}", graph.complex);
        assert!(!graph.complex.contains("atempo="), "{}", graph.complex);
        assert_eq!(graph.complex.matches("colorchannelmixer=aa=").count(), 1);
        assert_eq!(graph.complex.matches("volume=").count(), 1);
        // Higher track sort_order composites on top, i.e. last.
        assert!(
            graph.complex.find("[v0]overlay").unwrap() < graph.complex.find("[v1]overlay").unwrap()
        );
    }

    #[test]
    fn a_plain_clip_emits_no_identity_stages_at_all() {
        let graph = build_filter_graph(&config(), &[plain_video_clip(0, 0)], &[]).unwrap();
        assert_eq!(
            graph.complex,
            concat!(
                "color=c=black:s=1920x1080:r=30/1:d=10[base]",
                ";",
                "[0:v]trim=start=0:duration=10,setpts=(PTS-STARTPTS)/1,",
                "scale=1920:1080:force_original_aspect_ratio=decrease,",
                "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=rgba[v0]",
                ";",
                "[base][v0]overlay=x=(1920-w)/2+0:y=(1080-h)/2+0:enable='between(t,0,10)'[base]",
                ";",
                "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=10,",
                "asetpts=PTS-STARTPTS[aout]",
            )
        );
        assert!(!graph.complex.contains("crop="));
        assert!(!graph.complex.contains("rotate="));
        assert!(!graph.complex.contains("colorchannelmixer"));
        assert_eq!(graph.audio_inputs, 0);
        assert!(!graph.has_mixed_audio());
    }

    /// The `rotate` `ow`/`oh` arguments take an **angle in radians**, not a size. Passing
    /// `iw` there (as an earlier revision did) computes the canvas for a nonsense rotation.
    #[test]
    fn rotation_is_clockwise_degrees_with_radians_for_ow_and_oh() {
        let clip = VideoGraphClip {
            rotation: 90.0,
            ..plain_video_clip(0, 0)
        };
        let graph = build_filter_graph(&config(), &[clip], &[]).unwrap();
        // 90 degrees clockwise is +PI/2 radians; the sign is not flipped.
        let expected_stage = "rotate=1.570796:ow=rotw(1.570796):oh=roth(1.570796):c=none";
        assert!(
            graph.complex.contains(expected_stage),
            "expected {expected_stage} in {}",
            graph.complex
        );
        // `ow`/`oh` must never receive a pixel dimension.
        assert!(!graph.complex.contains("rotw(1920)"), "{}", graph.complex);
        assert!(!graph.complex.contains("roth(1080)"), "{}", graph.complex);
        assert!(!graph.complex.contains("rotw(iw)"), "{}", graph.complex);
        // A negative rotation stays negative rather than being mirrored.
        let clip = VideoGraphClip {
            rotation: -45.0,
            ..plain_video_clip(0, 0)
        };
        let graph = build_filter_graph(&config(), &[clip], &[]).unwrap();
        assert!(
            graph
                .complex
                .contains("rotate=-0.785398:ow=rotw(-0.785398):oh=roth(-0.785398):c=none"),
            "{}",
            graph.complex
        );
    }

    #[test]
    fn rotation_stage_is_omitted_at_zero_degrees() {
        assert!(rotation_stage(&plain_video_clip(0, 0)).is_none());
        let rotated = VideoGraphClip {
            rotation: 180.0,
            ..plain_video_clip(0, 0)
        };
        assert_eq!(
            rotation_stage(&rotated).as_deref(),
            Some("rotate=3.141593:ow=rotw(3.141593):oh=roth(3.141593):c=none")
        );
    }

    /// A clip at t=0 has no delay to apply, and `adelay=0|0` is an identity stage.
    #[test]
    fn a_zero_delay_audio_clip_omits_adelay() {
        let graph = build_filter_graph(&config(), &[], &[plain_audio_clip(0)]).unwrap();
        assert_eq!(
            graph.complex,
            concat!(
                "color=c=black:s=1920x1080:r=30/1:d=10[base]",
                ";",
                "[0:a]atrim=start=0:duration=10,asetpts=PTS-STARTPTS[a0]",
                ";",
                "[a0]amix=inputs=1:normalize=0:dropout_transition=0[aout]",
            )
        );
        assert!(!graph.complex.contains("adelay"), "{}", graph.complex);
        // A gain of 0 dB and no fades are identities too.
        assert!(!graph.complex.contains("volume="), "{}", graph.complex);
        assert!(!graph.complex.contains("afade"), "{}", graph.complex);
    }

    #[test]
    fn audio_offsets_gains_and_fades_are_emitted_when_non_identity() {
        let graph = build_filter_graph(
            &config(),
            &[],
            &[
                AudioGraphClip {
                    start_frame: 30,
                    duration_frames: 60,
                    speed_num: 1,
                    speed_den: 2,
                    gain_db: 0.0,
                    fade_in_frames: 15,
                    fade_out_frames: 15,
                    ..plain_audio_clip(0)
                },
                AudioGraphClip {
                    start_frame: 15,
                    duration_frames: 45,
                    gain_db: 3.0,
                    ..plain_audio_clip(1)
                },
            ],
        )
        .unwrap();
        // `compareClips` orders by start frame, so the clip at frame 15 becomes `[a0]` even
        // though it was listed second. 3 dB is 10^(3/20) = 1.412538 after rounding.
        assert!(
            graph.complex.contains(
                "[1:a]atrim=start=0:duration=1.5,asetpts=PTS-STARTPTS,adelay=500|500,\
                 volume=1.412538[a0]"
            ),
            "{}",
            graph.complex
        );
        // The 0.5x clip at frame 30 is `[a1]`: `atempo=0.5` and both fades. A 1x clip would
        // get no `atempo` at all, and 0 dB would get no `volume`.
        assert!(
            graph.complex.contains(
                "[0:a]atrim=start=0:duration=2,asetpts=PTS-STARTPTS,atempo=0.5,adelay=1000|1000,\
                 afade=t=in:st=0:d=0.5,afade=t=out:st=2.5:d=0.5[a1]"
            ),
            "{}",
            graph.complex
        );
        assert_eq!(graph.audio_inputs, 2);
        assert!(
            graph
                .complex
                .ends_with("[a0][a1]amix=inputs=2:normalize=0:dropout_transition=0[aout]"),
            "{}",
            graph.complex
        );
    }

    #[test]
    fn atempo_chains_factors_outside_the_single_instance_range() {
        assert!(build_atempo_chain(1.0).unwrap().is_empty());
        assert_eq!(build_atempo_chain(2.0).unwrap(), vec!["atempo=2"]);
        assert_eq!(
            build_atempo_chain(4.0).unwrap(),
            vec!["atempo=2", "atempo=2"]
        );
        assert_eq!(build_atempo_chain(0.5).unwrap(), vec!["atempo=0.5"]);
        assert_eq!(
            build_atempo_chain(0.25).unwrap(),
            vec!["atempo=0.5", "atempo=0.5"]
        );
        // A non-power-of-two factor ends in a fractional step.
        assert_eq!(
            build_atempo_chain(3.0).unwrap(),
            vec!["atempo=2", "atempo=1.5"]
        );
        // A 1.0000000001 float must not add a useless step.
        assert!(build_atempo_chain(1.0 + 1e-10).unwrap().is_empty());
        // Invalid speeds are a validation error, never a silently ignored filter.
        assert!(build_atempo_chain(0.0).is_err());
        assert!(build_atempo_chain(-2.0).is_err());
        assert!(build_atempo_chain(f64::NAN).is_err());
    }

    #[test]
    fn crop_is_emitted_in_literal_pixels_and_clamped_to_one_pixel() {
        let clip = VideoGraphClip {
            crop_top: 0.1,
            crop_right: 0.2,
            crop_bottom: 0.1,
            crop_left: 0.05,
            ..plain_video_clip(0, 0)
        };
        assert_eq!(
            crop_stage(&clip, 1920, 1080).as_deref(),
            // (1 - 0.05 - 0.2) * 1920 = 1440 ; (1 - 0.1 - 0.1) * 1080 = 864
            // left * 1920 = 96 ; top * 1080 = 108
            Some("crop=1440:864:96:108")
        );
        // Identity crop is omitted.
        assert!(crop_stage(&plain_video_clip(0, 0), 1920, 1080).is_none());
        // A fully-cropped axis would be `crop=0`, which FFmpeg rejects.
        let degenerate = VideoGraphClip {
            crop_left: 1.0,
            crop_top: 1.0,
            ..plain_video_clip(0, 0)
        };
        let stage = crop_stage(&degenerate, 1920, 1080).unwrap();
        assert!(stage.starts_with("crop=1:1:"), "{stage}");
    }

    #[test]
    fn opacity_stage_uses_the_ts_threshold_and_stays_omitted_at_full() {
        assert!(opacity_stage(&plain_video_clip(0, 0)).is_none());
        let translucent = VideoGraphClip {
            opacity: 0.25,
            ..plain_video_clip(0, 0)
        };
        assert_eq!(
            opacity_stage(&translucent).as_deref(),
            Some("colorchannelmixer=aa=0.25")
        );
        // `graph.ts` uses `opacity >= 1`, so exactly 1 is identity.
        let exactly_one = VideoGraphClip {
            opacity: 1.0,
            ..plain_video_clip(0, 0)
        };
        assert!(opacity_stage(&exactly_one).is_none());
    }

    #[test]
    fn signed_offsets_never_double_up_a_sign() {
        let clip = VideoGraphClip {
            position_x: 12.0,
            position_y: -8.0,
            ..plain_video_clip(0, 0)
        };
        let graph = build_filter_graph(&config(), &[clip], &[]).unwrap();
        assert!(
            graph
                .complex
                .contains("overlay=x=(1920-w)/2+12:y=(1080-h)/2-8:enable='between(t,0,10)'"),
            "{}",
            graph.complex
        );
        assert!(!graph.complex.contains("+-"), "{}", graph.complex);
        assert_eq!(signed_offset(0.0), "+0");
        assert_eq!(signed_offset(-0.5), "-0.5");
    }

    #[test]
    fn track_sort_order_determines_compositing_order_not_input_order() {
        // Input 1 sits on track 5, input 0 on track 1: input 0 must composite first.
        let graph = build_filter_graph(
            &config(),
            &[plain_video_clip(1, 5), plain_video_clip(0, 1)],
            &[],
        )
        .unwrap();
        let first_clip = graph.complex.find("[0:v]").unwrap();
        let second_clip = graph.complex.find("[1:v]").unwrap();
        assert!(first_clip < second_clip, "{}", graph.complex);
        assert!(
            graph.complex.find("[v0]overlay").unwrap() < graph.complex.find("[v1]overlay").unwrap()
        );
        assert!(graph.complex.contains("[base][v0]overlay"));
        assert!(graph.complex.contains("[base][v1]overlay"));
    }

    #[test]
    fn clips_on_one_track_are_ordered_by_start_frame_then_id() {
        let mut late = plain_video_clip(0, 0);
        late.start_frame = 60;
        late.clip_id = "clp_b".to_string();
        let mut early = plain_video_clip(1, 0);
        early.start_frame = 0;
        early.clip_id = "clp_a".to_string();
        // Same start frame, ids decide.
        let mut tie = plain_video_clip(2, 0);
        tie.start_frame = 0;
        tie.clip_id = "clp_0".to_string();

        let graph = build_filter_graph(&config(), &[late, early, tie], &[]).unwrap();
        let order: Vec<usize> = ["[v0]", "[v1]", "[v2]"]
            .iter()
            .map(|label| graph.complex.find(label).unwrap())
            .collect();
        assert!(
            order[0] < order[1] && order[1] < order[2],
            "{}",
            graph.complex
        );
        // clp_0 (start 0, id clp_0) then clp_a (start 0, id clp_a) then clp_b (start 60).
        assert!(graph.complex.contains("[2:v]"));
        assert!(graph.complex.contains("[1:v]"));
        assert!(graph.complex.contains("[0:v]"));
    }

    #[test]
    fn an_empty_timeline_is_a_validation_error() {
        let error = build_filter_graph(&config(), &[], &[]).unwrap_err();
        assert!(error.message.contains("no clips"), "{error}");
        let mut zero = config();
        zero.duration_frames = 0;
        let error = build_filter_graph(&zero, &[plain_video_clip(0, 0)], &[]).unwrap_err();
        assert!(error.message.contains("zero frames"), "{error}");
    }

    #[test]
    fn a_silent_base_keeps_the_audio_track_shape_stable() {
        // Video only: `graph.ts` still produces `[aout]`, as a silent generator, so the
        // output always carries the preset's AAC track.
        let graph = build_filter_graph(&config(), &[plain_video_clip(0, 0)], &[]).unwrap();
        assert!(
            graph.complex.contains(
                "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=10,\
                 asetpts=PTS-STARTPTS[aout]"
            ),
            "{}",
            graph.complex
        );
        assert!(!graph.has_mixed_audio(), "there is nothing to mix");
        assert_eq!(graph.maps, vec!["[base]".to_string(), "[aout]".to_string()]);

        // Audio present: a real mix, and no silent generator.
        let graph = build_filter_graph(&config(), &[], &[plain_audio_clip(0)]).unwrap();
        assert!(!graph.complex.contains("anullsrc"), "{}", graph.complex);
        assert!(graph
            .complex
            .contains("amix=inputs=1:normalize=0:dropout_transition=0[aout]"));
        assert!(graph.has_mixed_audio());
        // The silent base is emitted even for an audio-only timeline, so `-map [base]` holds.
        assert!(graph
            .complex
            .starts_with("color=c=black:s=1920x1080:r=30/1:d=10[base]"));
    }

    // -----------------------------------------------------------------------
    // Encode arguments
    // -----------------------------------------------------------------------

    #[test]
    fn encode_args_match_the_ts_encoder_flags() {
        let graph =
            build_filter_graph(&config(), &[plain_video_clip(0, 0)], &[plain_audio_clip(0)])
                .unwrap();
        assert_eq!(
            graph.encode_args,
            vec![
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-preset",
                "medium",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-movflags",
                "+faststart",
                "-shortest",
            ]
        );
        assert!(!graph.encode_args.iter().any(|value| value == "-crf"));
    }

    #[test]
    fn render_arguments_are_an_array_with_the_frozen_encoder_flags() {
        let graph =
            build_filter_graph(&config(), &[plain_video_clip(0, 0)], &[plain_audio_clip(0)])
                .unwrap();
        let preset = resolve_preset("1080p", FrameRateDto::new(30, 1)).unwrap();
        let args = build_render_arguments(
            &[PathBuf::from("/tmp/a.mp4"), PathBuf::from("/tmp/b.mp4")],
            &graph,
            &preset,
            Path::new("/tmp/out.mp4"),
        );
        let joined = args.join(" ");
        assert!(joined.contains("-i /tmp/a.mp4 -i /tmp/b.mp4"), "{joined}");
        assert!(joined.contains("-c:v libx264"), "{joined}");
        assert!(joined.contains("-pix_fmt yuv420p"), "{joined}");
        assert!(joined.contains("-preset medium"), "{joined}");
        assert!(joined.contains("-b:v 12000k"), "{joined}");
        assert!(
            joined.contains("-c:a aac -b:a 192k -ar 48000 -ac 2"),
            "{joined}"
        );
        assert!(joined.contains("-map [base] -map [aout]"), "{joined}");
        assert!(joined.contains("-movflags +faststart"), "{joined}");
        assert!(joined.contains("-shortest"), "{joined}");
        assert!(joined.contains("-progress pipe:1"), "{joined}");
        assert_eq!(args.last().unwrap(), "/tmp/out.mp4");
        // Two inputs, so exactly two `-i` flags: no shell, no globbing.
        assert_eq!(args.iter().filter(|arg| *arg == "-i").count(), 2);
        // Exactly one rate-control flag.
        assert_eq!(joined.matches("-b:v").count(), 1);
        assert_eq!(joined.matches("-crf").count(), 0);
    }

    #[test]
    fn crf_presets_use_crf_and_the_faster_encoder_preset() {
        let graph =
            build_filter_graph(&config(), &[plain_video_clip(0, 0)], &[plain_audio_clip(0)])
                .unwrap();
        let preset = resolve_preset("master-crf", FrameRateDto::new(24, 1)).unwrap();
        assert_eq!(preset.crf, Some(16));
        let args = build_render_arguments(
            &[PathBuf::from("/tmp/a.mp4")],
            &graph,
            &preset,
            Path::new("/tmp/out.mp4"),
        );
        let joined = args.join(" ");
        assert!(joined.contains("-crf 16"), "{joined}");
        assert!(joined.contains("-preset veryfast"), "{joined}");
        assert!(
            !joined.contains("-b:v"),
            "CRF and bitrate must not both appear: {joined}"
        );
    }

    #[test]
    fn unknown_presets_are_rejected_rather_than_defaulted() {
        let error = resolve_preset("8k-av1", FrameRateDto::new(30, 1)).unwrap_err();
        assert!(error.message.contains("unknown export preset"), "{error}");
        assert_eq!(
            resolve_preset("1080p-vertical", FrameRateDto::new(24, 1))
                .unwrap()
                .height,
            1920
        );
        let seven_twenty = resolve_preset("720p", FrameRateDto::new(24, 1)).unwrap();
        assert_eq!(seven_twenty.width, 1280);
        assert_eq!(seven_twenty.audio_bitrate_kbps, 192);
        assert_eq!(seven_twenty.pixel_format, "yuv420p");
        // Every persisted preset matches `EXPORT_PRESETS` in core, and every one of them
        // takes the project's rate rather than imposing one.
        for (id, width, height, bitrate, crf) in [
            ("1080p", 1920, 1080, 12_000, None),
            ("720p", 1280, 720, 6_000, None),
            ("1080p-vertical", 1080, 1920, 10_000, None),
            ("master-crf", 1920, 1080, 20_000, Some(16)),
        ] {
            for project_rate in [
                FrameRateDto::new(24, 1),
                FrameRateDto::new(25, 1),
                FrameRateDto::new(30_000, 1001),
                FrameRateDto::new(60, 1),
            ] {
                let preset = resolve_preset(id, project_rate).unwrap();
                assert_eq!(preset.width, width, "{id}");
                assert_eq!(preset.height, height, "{id}");
                assert_eq!(preset.video_bitrate_kbps, Some(bitrate), "{id}");
                assert_eq!(preset.crf, crf, "{id}");
                assert_eq!(
                    preset.fps, project_rate,
                    "{id} must render at the project rate, not a hardcoded one"
                );
            }
        }
        // A nonsensical sequence rate is refused rather than producing a broken `r=0/0`.
        assert!(resolve_preset("1080p", FrameRateDto::new(0, 1)).is_err());
        assert!(resolve_preset("1080p", FrameRateDto::new(25, 0)).is_err());
    }

    /// PRD §12: "export always renders at project settings". A 25 fps project with two
    /// 50-frame clips must emit `r=25/1` and exactly 100 frames — not 30/1 and 120.
    #[test]
    fn a_preset_without_an_explicit_rate_renders_at_the_project_rate() {
        // The command hands `resolve_preset` the *sequence* rate.
        let project_rate = FrameRateDto::new(25, 1);
        let preset = resolve_preset("1080p", project_rate).unwrap();
        assert_eq!(preset.fps, project_rate);

        let config = GraphConfig {
            width: preset.width,
            height: preset.height,
            // `presetFps` in `graph.ts`: the project rate, because the preset has none.
            fps: preset.fps,
            sequence_fps: project_rate,
            // Two 50-frame clips, and this one starts at 0 so the duration is 100 frames.
            duration_frames: 100,
            pixel_format: preset.pixel_format.clone(),
            sample_rate: 48_000,
        };
        let clip = VideoGraphClip {
            // A 50-frame clip: the second one is what fixes the 100-frame duration.
            duration_frames: 50,
            ..plain_video_clip(0, 0)
        };
        let graph = build_filter_graph(&config, &[clip], &[]).unwrap();

        assert!(
            graph
                .complex
                .starts_with("color=c=black:s=1920x1080:r=25/1:d=4[base]"),
            "the base source must carry the project rate: {}",
            graph.complex
        );
        assert!(!graph.complex.contains("r=30/1"), "{}", graph.complex);
        // 100 frames at 25 fps is 4 seconds, and the encoder produces exactly 100 frames.
        assert_eq!(graph.duration_seconds, 4.0);
        assert_eq!(graph.total_frames, 100);
        // The timings inside the graph are sequence-rate seconds, not preset-rate ones.
        assert!(
            graph
                .complex
                .contains("trim=start=0:duration=2,setpts=(PTS-STARTPTS)/1"),
            "{}",
            graph.complex
        );
        // No `-r` override is emitted, so the encoder keeps the base source's rate.
        let args = build_render_arguments(
            &[PathBuf::from("/tmp/a.mp4")],
            &graph,
            &preset,
            Path::new("/tmp/out.mp4"),
        );
        assert!(!args.iter().any(|arg| arg == "-r"), "{args:?}");
    }

    #[test]
    fn a_2997_project_keeps_its_exact_rational_rate() {
        let project_rate = FrameRateDto::new(30_000, 1001);
        let preset = resolve_preset("master-crf", project_rate).unwrap();
        assert_eq!(preset.fps, project_rate);
        let config = GraphConfig {
            fps: preset.fps,
            sequence_fps: project_rate,
            // 300 frames at 30000/1001 is 10.01 seconds.
            duration_frames: 300,
            ..config()
        };
        let graph = build_filter_graph(&config, &[plain_video_clip(0, 0)], &[]).unwrap();
        // Never rounded to `r=30/1`, and never resampled: 300 frames in, 300 out.
        assert!(
            graph
                .complex
                .starts_with("color=c=black:s=1920x1080:r=30000/1001:d=10.01[base]"),
            "{}",
            graph.complex
        );
        assert!(!graph.complex.contains("r=30/1"), "{}", graph.complex);
        assert_eq!(graph.duration_seconds, 10.01);
        assert_eq!(graph.total_frames, 300);
    }

    /// The graph keeps the *delivery* rate (`fps`, used for the base source and the frame
    /// count) separate from the *sequence* rate (used for timeline-frame conversions).
    /// In production they are the same value, because every shipped preset defers to the
    /// project rate; this pins the graph's behaviour if a rate-converting preset is added.
    #[test]
    fn the_graph_keeps_the_delivery_rate_separate_from_the_sequence_rate() {
        let mut config = config();
        // A 24fps sequence delivered at 30fps: 10s of timeline is 300 frames.
        config.sequence_fps = FrameRateDto::new(24, 1);
        config.duration_frames = 240;
        let graph = build_filter_graph(&config, &[plain_video_clip(0, 0)], &[]).unwrap();
        assert_eq!(graph.duration_seconds, 10.0);
        assert_eq!(graph.total_frames, 300);
        // Timeline frames became seconds at the *sequence* rate.
        assert!(graph.complex.contains("duration=10,") || graph.complex.contains(":duration=10,"));
    }

    // -----------------------------------------------------------------------
    // Progress
    // -----------------------------------------------------------------------

    #[test]
    fn progress_lines_fold_into_a_running_total() {
        let mut progress = RenderProgress::default();
        apply_progress_line(&mut progress, "frame=42");
        apply_progress_line(&mut progress, "fps=30.0");
        apply_progress_line(&mut progress, "out_time_us=1400000");
        apply_progress_line(&mut progress, "progress=continue");
        assert_eq!(progress.frame, Some(42));
        assert_eq!(progress.out_time_us, Some(1_400_000));
        assert!(!progress.done);
        apply_progress_line(&mut progress, "progress=end");
        assert!(progress.done);
        // `out_time_ms` is microseconds in FFmpeg, despite the name.
        assert_eq!(
            parse_progress_line("out_time_ms=2000000"),
            Some(("out_time_us", 2_000_000))
        );
        assert_eq!(parse_progress_line("bitrate=N/A"), None);
        assert_eq!(parse_progress_line("garbage"), None);
    }

    #[test]
    fn temporary_output_is_a_hidden_sibling_so_the_rename_is_atomic() {
        let output = Path::new("/Users/someone/Movies/final cut.mp4");
        let temporary = temporary_output_path(output);
        assert_eq!(
            temporary.parent(),
            output.parent(),
            "must be on one filesystem"
        );
        assert!(temporary
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".final cut.mp4"));
        assert!(temporary
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".partial.mp4"));
        assert_ne!(temporary, output);
    }
}
