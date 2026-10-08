//! FFmpeg / ffprobe integration.
//!
//! ## No shell, ever
//! Every child process is spawned with [`tokio::process::Command`] in **argument-array**
//! form. There is no `sh -c`, no string interpolation into a command line, and no
//! renderer-controlled argv beyond *values* that are passed as discrete arguments. The
//! `argument_passing_is_verbatim_and_never_shell_interpreted` test proves the mechanism:
//! a value containing `; rm -rf /` arrives at the child as that literal string.
//!
//! ## Where output lands
//! Thumbnails, waveforms and proxies are written into `cache/thumbnails`,
//! `cache/waveforms` and `cache/proxies` through
//! [`crate::security::WorkspaceScope`], so the media pipeline cannot write outside the
//! project even if an asset's stored relative path were tampered with.

use std::path::{Path, PathBuf};

use tokio::process::Command;

use crate::error::{CommandError, CommandResult};
use crate::protocol::{AssetDto, FrameRateDto};

/// Where the Homebrew binaries live on the target machine. `PATH` is consulted as a
/// fallback so a different install location still works.
pub const FALLBACK_PATHS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/// Reproduce the media crate's extension table so the Rust and TypeScript probes agree.
pub fn media_type_for(extension: &str) -> &'static str {
    match extension.to_ascii_lowercase().as_str() {
        "mp4" | "mov" | "webm" | "mkv" | "m4v" | "avi" | "mxf" => "video",
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tif" | "tiff" | "heic" => "image",
        "wav" | "mp3" | "m4a" | "aac" | "flac" | "ogg" | "opus" | "aif" | "aiff" => "audio",
        "srt" | "vtt" | "ass" | "ssa" => "subtitle",
        _ => "video",
    }
}

pub fn media_type_for_path(path: &Path) -> &'static str {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(media_type_for)
        .unwrap_or("video")
}

/// Locate a bundled-or-system binary by name.
///
/// Deliberately conservative: only `PATH` plus the three well-known install prefixes.
/// Nothing derived from user input ever reaches this function.
pub fn find_binary(name: &str) -> CommandResult<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    for directory in FALLBACK_PATHS {
        let candidate = Path::new(directory).join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(CommandError::configuration(format!(
        "{name} was not found on PATH or in {}. Install FFmpeg 9.x and restart the app.",
        FALLBACK_PATHS.join(", ")
    )))
}

pub fn ffmpeg_path() -> CommandResult<PathBuf> {
    find_binary("ffmpeg")
}

pub fn ffprobe_path() -> CommandResult<PathBuf> {
    find_binary("ffprobe")
}

/// A fresh `tokio::process::Command` for ffprobe, with stdout captured and stderr dropped
/// into the error path.
fn ffprobe_command() -> CommandResult<Command> {
    let mut command = Command::new(ffprobe_path()?);
    command.arg("-hide_banner").arg("-loglevel").arg("error");
    Ok(command)
}

/// A fresh `tokio::process::Command` for ffmpeg.
fn ffmpeg_command() -> CommandResult<Command> {
    let mut command = Command::new(ffmpeg_path()?);
    command.arg("-hide_banner").arg("-nostdin");
    Ok(command)
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/// The normalized probe shape. `packages/media` produces the same keys so a probe
/// round-trips between the two implementations.
///
/// ```json
/// {
///   "mediaType": "video", "formatName": "mov,mp4,m4a,3gp,3g2,mj2",
///   "durationSeconds": 3.0, "durationFrames": 90, "width": 1920, "height": 1080,
///   "fps": { "num": 30, "den": 1 }, "sampleRate": 48000, "channels": 2,
///   "codec": "h264", "audioCodec": "aac", "bitrate": 1234567,
///   "hasVideo": true, "hasAudio": true, "rotation": 0,
///   "streams": [ { "index": 0, "type": "video", "codec": "h264", ... } ]
/// }
/// ```
#[derive(Debug, Clone)]
pub struct MediaProbe {
    pub media_type: String,
    pub format_name: Option<String>,
    pub container: Option<String>,
    pub duration_seconds: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<FrameRateDto>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bitrate: Option<i64>,
    pub has_video: bool,
    pub has_audio: bool,
    pub rotation: Option<i64>,
    pub raw: serde_json::Value,
}

impl MediaProbe {
    pub fn duration_frames(&self, fps: Option<FrameRateDto>) -> Option<i64> {
        let seconds = self.duration_seconds?;
        let rate = fps.or(self.fps)?;
        Some(rate.seconds_to_frames(seconds))
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "mediaType": self.media_type,
            "formatName": self.format_name,
            "container": self.container,
            "durationSeconds": self.duration_seconds,
            "width": self.width,
            "height": self.height,
            "fps": self.fps.map(|fps| serde_json::json!({ "num": fps.num, "den": fps.den })),
            "sampleRate": self.sample_rate,
            "channels": self.channels,
            "codec": self.codec,
            "audioCodec": self.audio_codec,
            "bitrate": self.bitrate,
            "hasVideo": self.has_video,
            "hasAudio": self.has_audio,
            "rotation": self.rotation,
            "streams": self.raw.get("streams").cloned().unwrap_or(serde_json::json!([])),
            "format": self.raw.get("format").cloned().unwrap_or(serde_json::json!({})),
        })
    }
}

fn parse_rational(value: Option<&str>) -> Option<FrameRateDto> {
    let value = value?;
    let (num, den) = value.split_once('/')?;
    let num: i64 = num.trim().parse().ok()?;
    let den: i64 = den.trim().parse().ok()?;
    if num <= 0 || den <= 0 {
        return None;
    }
    Some(FrameRateDto::new(num, den))
}

fn parse_number(value: Option<&str>) -> Option<f64> {
    value?.trim().parse().ok()
}

fn parse_integer(value: Option<&str>) -> Option<i64> {
    value?.trim().parse().ok()
}

/// `ffprobe -show_format -show_streams -of json`.
pub async fn probe_file(path: &Path) -> CommandResult<MediaProbe> {
    if !path.is_file() {
        return Err(CommandError::media(format!(
            "cannot probe {}: file not found",
            path.display()
        )));
    }
    let mut command = ffprobe_command()?;
    command
        .arg("-show_format")
        .arg("-show_streams")
        .arg("-of")
        .arg("json")
        // `--` terminates option parsing so a file name that begins with `-` is treated
        // as a path, not as a flag.
        .arg("--")
        .arg(path);
    let output = command.output().await.map_err(|error| {
        CommandError::from_io(
            &format!("could not run ffprobe on {}", path.display()),
            &error,
        )
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CommandError::media(format!(
            "ffprobe failed for {}: {}",
            path.display(),
            tail_lines(&stderr, 4).join(" ")
        )));
    }
    let raw: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        CommandError::media(format!("ffprobe returned unparsable JSON: {error}"))
    })?;
    Ok(normalize_probe(&raw, media_type_for_path(path)))
}

/// Turn a raw ffprobe document into the normalized shape. Pure, so the mapping is
/// testable without invoking ffprobe.
pub fn normalize_probe(raw: &serde_json::Value, fallback_type: &str) -> MediaProbe {
    let streams = raw
        .get("streams")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let format = raw.get("format").cloned().unwrap_or(serde_json::json!({}));

    let video = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(|value| value.as_str()) == Some("video"));
    let audio = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(|value| value.as_str()) == Some("audio"));

    let fps = video
        .and_then(|stream| {
            stream
                .get("avg_frame_rate")
                .and_then(|value| value.as_str())
        })
        .and_then(|value| parse_rational(Some(value)))
        .or_else(|| {
            video
                .and_then(|stream| stream.get("r_frame_rate").and_then(|value| value.as_str()))
                .and_then(|value| parse_rational(Some(value)))
        })
        // `avg_frame_rate` is `0/0` for a still image, which parses to `None` above.
        .or_else(|| {
            let rate = video?.get("r_frame_rate")?.as_str()?;
            parse_rational(Some(rate))
        });

    let rotation = video
        .and_then(|stream| stream.get("side_data_list"))
        .and_then(|value| value.as_array())
        .and_then(|list| {
            list.iter()
                .find_map(|entry| entry.get("rotation").and_then(|value| value.as_i64()))
        });

    let width = video.and_then(|stream| stream.get("width").and_then(|value| value.as_i64()));
    let height = video.and_then(|stream| stream.get("height").and_then(|value| value.as_i64()));

    let duration_seconds = format
        .get("duration")
        .and_then(|value| value.as_str())
        .and_then(|value| parse_number(Some(value)))
        .or_else(|| {
            video
                .and_then(|stream| stream.get("duration").and_then(|value| value.as_str()))
                .and_then(|value| parse_number(Some(value)))
        });

    let format_name = format
        .get("format_name")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let container = format_name
        .as_ref()
        .and_then(|name| name.split(',').next())
        .map(str::to_string);

    let media_type = if video.is_some() {
        "video"
    } else if audio.is_some() {
        "audio"
    } else {
        fallback_type
    };

    MediaProbe {
        media_type: media_type.to_string(),
        format_name,
        container,
        duration_seconds,
        width,
        height,
        fps,
        sample_rate: audio
            .and_then(|stream| stream.get("sample_rate").and_then(|value| value.as_str()))
            .and_then(|value| parse_integer(Some(value))),
        channels: audio.and_then(|stream| stream.get("channels").and_then(|value| value.as_i64())),
        codec: video
            .and_then(|stream| stream.get("codec_name").and_then(|value| value.as_str()))
            .map(str::to_string),
        audio_codec: audio
            .and_then(|stream| stream.get("codec_name").and_then(|value| value.as_str()))
            .map(str::to_string),
        bitrate: format
            .get("bit_rate")
            .and_then(|value| value.as_str())
            .and_then(|value| parse_integer(Some(value))),
        has_video: video.is_some(),
        has_audio: audio.is_some(),
        rotation,
        raw: raw.clone(),
    }
}

/// Refresh an asset row's probed columns from a probe result.
pub fn apply_probe_to_asset(asset: &mut AssetDto, probe: &MediaProbe) {
    asset.media_type = probe.media_type.clone();
    if asset.media_type == "audio" {
        asset.width = None;
        asset.height = None;
        asset.fps = None;
    } else {
        asset.width = probe.width;
        asset.height = probe.height;
        asset.fps = probe.fps;
    }
    asset.sample_rate = probe.sample_rate;
    asset.channels = probe.channels;
    asset.codec = probe.codec.clone().or_else(|| probe.audio_codec.clone());
    asset.container = probe.container.clone();
    asset.duration_frames = probe.duration_frames(asset.fps);
    asset.probe = Some(probe.to_json());
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/// One frame at `at_seconds`, scaled to `width` (even height, aspect preserved).
pub async fn generate_thumbnail(
    source: &Path,
    destination: &Path,
    at_seconds: f64,
    width: i64,
) -> CommandResult<(i64, i64)> {
    let width = width.clamp(16, 4096);
    let width = if width % 2 == 0 { width } else { width + 1 };
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            CommandError::from_io("could not create the thumbnail directory", &error)
        })?;
    }
    let mut command = ffmpeg_command()?;
    command
        .arg("-y")
        .arg("-loglevel")
        .arg("error")
        // `-ss` before `-i` seeks by keyframe and is dramatically faster; a thumbnail
        // does not need frame-exact seeking.
        .arg("-ss")
        .arg(format_number(at_seconds.max(0.0), 6))
        .arg("-i")
        .arg(source)
        .arg("-frames:v")
        .arg("1")
        .arg("-vf")
        .arg(format!("scale={width}:-2:flags=lanczos"))
        .arg("-f")
        .arg("image2")
        .arg("-c:v")
        .arg("png")
        .arg(destination);
    run_to_completion(command, "ffmpeg thumbnail").await?;

    // Read the real output size back rather than predicting it.
    let probe = probe_file(destination).await?;
    Ok((probe.width.unwrap_or(width), probe.height.unwrap_or(0)))
}

// ---------------------------------------------------------------------------
// Waveforms
// ---------------------------------------------------------------------------

/// Decode to mono `f32le` and reduce to `buckets` min/max pairs.
///
/// `peaks[i] = [min, max]`, both in `[-1, 1]`, matching the `MediaWaveformResponse`
/// contract. Decoded samples are streamed rather than held, so a long file costs memory
/// proportional to the bucket count, not the duration.
pub async fn generate_waveform(
    source: &Path,
    cache_path: &Path,
    buckets: i64,
) -> CommandResult<Vec<Vec<f64>>> {
    let buckets = buckets.clamp(1, 200_000) as usize;
    let mut command = ffmpeg_command()?;
    command
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(source)
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("8000")
        .arg("-f")
        .arg("f32le")
        .arg("-acodec")
        .arg("pcm_f32le")
        .arg("pipe:1");
    // `tokio::process::Command` accepts any `Into<std::process::Stdio>`; the standard
    // library type is the one that is publicly convertible.
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let mut child = command.spawn().map_err(|error| {
        CommandError::from_io(
            &format!("could not run ffmpeg on {}", source.display()),
            &error,
        )
    })?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| CommandError::internal("ffmpeg stdout was not piped"))?;

    let mut samples: Vec<f32> = Vec::new();
    let mut buffer = [0u8; 64 * 1024];
    use tokio::io::AsyncReadExt;
    loop {
        let read = stdout.read(&mut buffer).await.map_err(|error| {
            CommandError::from_io("could not read decoded audio from ffmpeg", &error)
        })?;
        if read == 0 {
            break;
        }
        for chunk in buffer[..read].chunks_exact(4) {
            samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
    }
    let status = child
        .wait()
        .await
        .map_err(|error| CommandError::from_io("ffmpeg did not report an exit status", &error))?;
    if !status.success() {
        return Err(CommandError::media(format!(
            "ffmpeg could not decode audio from {}",
            source.display()
        )));
    }

    // `peaks` leaves this module as `Vec<Vec<f64>>` — the exact `MediaWaveformResponse`
    // shape (`number[][]`), so no conversion is needed on the IPC path.
    let peaks: Vec<Vec<f64>> = reduce_to_peaks(&samples, buckets)
        .into_iter()
        .map(|pair| pair.to_vec())
        .collect();
    let serialized = serde_json::json!({
        "buckets": buckets,
        "peaks": peaks,
    });
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            CommandError::from_io("could not create the waveform directory", &error)
        })?;
    }
    std::fs::write(
        cache_path,
        serde_json::to_vec(&serialized).unwrap_or_default(),
    )
    .map_err(|error| CommandError::from_io("could not write the waveform cache", &error))?;
    Ok(peaks)
}

/// Pure bucket reduction — testable without ffmpeg.
pub fn reduce_to_peaks(samples: &[f32], buckets: usize) -> Vec<[f64; 2]> {
    let buckets = buckets.max(1);
    if samples.is_empty() {
        return vec![[0.0, 0.0]; buckets];
    }
    let mut peaks = Vec::with_capacity(buckets);
    for index in 0..buckets {
        let start = index * samples.len() / buckets;
        let end = ((index + 1) * samples.len() / buckets)
            .max(start + 1)
            .min(samples.len());
        let mut minimum = f32::MAX;
        let mut maximum = f32::MIN;
        for sample in &samples[start..end] {
            let value = if sample.is_finite() { *sample } else { 0.0 };
            minimum = minimum.min(value);
            maximum = maximum.max(value);
        }
        if start >= samples.len() {
            peaks.push([0.0, 0.0]);
            continue;
        }
        peaks.push([
            f64::from(minimum.clamp(-1.0, 1.0)),
            f64::from(maximum.clamp(-1.0, 1.0)),
        ]);
    }
    peaks
}

// ---------------------------------------------------------------------------
// Proxies
// ---------------------------------------------------------------------------

/// A low-bitrate H.264 proxy no wider than `max_width`, with `+faststart` so scrubbing
/// can begin before the file is fully read.
pub async fn generate_proxy(
    source: &Path,
    destination: &Path,
    max_width: i64,
) -> CommandResult<(i64, i64, i64)> {
    let max_width = max_width.clamp(160, 3840);
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            CommandError::from_io("could not create the proxy directory", &error)
        })?;
    }
    let mut command = ffmpeg_command()?;
    command
        .arg("-y")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(source)
        .arg("-vf")
        .arg(format!(
            // Never upscale: `min(iw, max)` and even output dimensions.
            "scale='min({max_width},iw)':-2:flags=bicubic"
        ))
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("veryfast")
        .arg("-crf")
        .arg("28")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("128k")
        .arg("-movflags")
        .arg("+faststart")
        .arg(destination);
    run_to_completion(command, "ffmpeg proxy").await?;

    let probe = probe_file(destination).await?;
    let bytes = std::fs::metadata(destination)
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(0);
    Ok((
        probe.width.unwrap_or(max_width),
        probe.height.unwrap_or(0),
        bytes,
    ))
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Run a **blocking** `std::process::Command` to completion, surfacing the stderr tail on
/// failure. Used by the synchronous commands, which already run on Tauri's blocking pool.
pub fn run_blocking(command: &mut std::process::Command, what: &str) -> CommandResult<()> {
    let output = command
        .output()
        .map_err(|error| CommandError::from_io(&format!("could not run {what}"), &error))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Err(CommandError::media(format!(
        "{what} failed: {}",
        tail_lines(&stderr, 4).join(" | ")
    )))
}

/// Blocking `ffprobe`. Commands are declared synchronous, so they run on Tauri's blocking
/// pool; using the blocking API there avoids nesting a runtime.
pub fn probe_file_blocking(path: &Path) -> CommandResult<MediaProbe> {
    if !path.is_file() {
        return Err(CommandError::media(format!(
            "cannot probe {}: file not found",
            path.display()
        )));
    }
    let mut command = std::process::Command::new(ffprobe_path()?);
    let output = command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-show_format")
        .arg("-show_streams")
        .arg("-of")
        .arg("json")
        // `--` terminates option parsing so a file name beginning with `-` is a path, not
        // a flag.
        .arg("--")
        .arg(path)
        .output()
        .map_err(|error| {
            CommandError::from_io(
                &format!("could not run ffprobe on {}", path.display()),
                &error,
            )
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CommandError::media(format!(
            "ffprobe failed for {}: {}",
            path.display(),
            tail_lines(&stderr, 4).join(" ")
        )));
    }
    let raw: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        CommandError::media(format!("ffprobe returned unparsable JSON: {error}"))
    })?;
    Ok(normalize_probe(&raw, media_type_for_path(path)))
}

/// Streaming SHA-256 of a file, used for asset identity and duplicate detection (FR-02).
///
/// Streamed rather than slurped: an imported original can be several gigabytes and the
/// machine may have far less free memory than that.
pub fn hash_file(path: &Path) -> CommandResult<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|error| {
        CommandError::from_io(&format!("could not read {}", path.display()), &error)
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            CommandError::from_io(&format!("could not read {}", path.display()), &error)
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// `name (2).ext`, `name (3).ext`, … avoiding a collision with `taken`. Mirrors
/// `uniqueFileName` in `packages/core/src/workspace.ts`.
pub fn unique_file_name(taken: &[String], desired: &str) -> String {
    if !taken.iter().any(|candidate| candidate == desired) {
        return desired.to_string();
    }
    let (stem, extension) = match desired.rfind('.') {
        Some(index) if index > 0 => (&desired[..index], &desired[index..]),
        _ => (desired, ""),
    };
    for index in 2..10_000 {
        let candidate = format!("{stem} ({index}){extension}");
        if !taken.iter().any(|existing| *existing == candidate) {
            return candidate;
        }
    }
    // Astronomically unlikely; fall back to a unique suffix rather than looping forever.
    format!("{stem}-{}{extension}", uuid::Uuid::new_v4().simple())
}

/// Run a **tokio** command to completion.
pub async fn run_to_completion(mut command: Command, what: &str) -> CommandResult<()> {
    let output = command
        .output()
        .await
        .map_err(|error| CommandError::from_io(&format!("could not run {what}"), &error))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Err(CommandError::media(format!(
        "{what} failed: {}",
        tail_lines(&stderr, 4).join(" | ")
    )))
}

/// The last `count` non-empty lines of a log, for a bounded error message.
pub fn tail_lines(text: &str, count: usize) -> Vec<String> {
    let mut lines: Vec<String> = text
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    if lines.len() > count {
        lines = lines.split_off(lines.len() - count);
    }
    lines
}

/// Format a float for an FFmpeg filter expression.
///
/// The contract with `formatFilterNumber` in `packages/media/src/graph.ts`: fixed decimals
/// (never exponent notation), trailing zeros stripped, no `-0`, never the empty string. Both
/// builders must produce byte-identical numbers or preview and export disagree (FR-04).
pub fn format_number(value: f64, decimals: usize) -> String {
    if !value.is_finite() {
        return "0".to_string();
    }
    let mut text = format!("{value:.decimals$}");
    // Rust's fixed formatting never emits exponent notation, so `toFixed`'s exponent
    // fallback (`value.toString()`) has no counterpart here.
    if text.contains('.') {
        while text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
    }
    if text.is_empty() || text == "-0" || text == "-" {
        return "0".to_string();
    }
    text
}

/// `10^(db/20)`, rounded to six decimals — the linear multiplier for `volume=`.
pub fn db_to_linear(db: f64) -> f64 {
    let linear = 10f64.powf(db / 20.0);
    (linear * 1_000_000.0).round() / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The no-shell proof required by PRD §13: a metacharacter-laden value is delivered
    /// to the child verbatim because `Command` passes argv directly to `execve`.
    #[test]
    fn argument_passing_is_verbatim_and_never_shell_interpreted() {
        let payload = "; rm -rf /";
        let output = std::process::Command::new("printf")
            .arg("%s")
            .arg(payload)
            .output()
            .expect("printf must exist on macOS");
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert_eq!(stdout, payload, "the argument was not delivered verbatim");

        // And a value with a space is still exactly one argument, not two.
        let spaced = "a b ; c | d && e";
        let output = std::process::Command::new("printf")
            .arg("%s")
            .arg(spaced)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(output.stdout).unwrap(), spaced);
    }

    #[test]
    fn frame_rate_parsing_handles_the_usual_ffprobe_rationals() {
        assert_eq!(
            parse_rational(Some("30000/1001")),
            Some(FrameRateDto::new(30_000, 1001))
        );
        assert_eq!(parse_rational(Some("25/1")), Some(FrameRateDto::new(25, 1)));
        assert_eq!(parse_rational(Some("0/0")), None);
        assert_eq!(parse_rational(Some("30")), None);
        assert_eq!(parse_rational(None), None);
    }

    #[test]
    fn normalize_probe_extracts_video_and_audio_metadata() {
        let raw = serde_json::json!({
            "streams": [
                {
                    "index": 0,
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1080,
                    "height": 1920,
                    "avg_frame_rate": "30000/1001",
                    "r_frame_rate": "30000/1001",
                    "duration": "5.005",
                    "side_data_list": [{ "rotation": -90 }]
                },
                {
                    "index": 1,
                    "codec_type": "audio",
                    "codec_name": "aac",
                    "sample_rate": "48000",
                    "channels": 2
                }
            ],
            "format": { "format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "5.005", "bit_rate": "1200000" }
        });
        let probe = normalize_probe(&raw, "video");
        assert_eq!(probe.media_type, "video");
        assert_eq!(probe.container.as_deref(), Some("mov"));
        assert_eq!(probe.width, Some(1080));
        assert_eq!(probe.height, Some(1920));
        assert_eq!(probe.fps, Some(FrameRateDto::new(30_000, 1001)));
        assert_eq!(probe.sample_rate, Some(48_000));
        assert_eq!(probe.channels, Some(2));
        assert_eq!(probe.codec.as_deref(), Some("h264"));
        assert_eq!(probe.audio_codec.as_deref(), Some("aac"));
        assert_eq!(probe.bitrate, Some(1_200_000));
        assert_eq!(probe.rotation, Some(-90));
        assert!(probe.has_video && probe.has_audio);
        // 5.005s at 29.97fps ~= 150 frames.
        assert_eq!(probe.duration_frames(None), Some(150));
        let json = probe.to_json();
        assert_eq!(json["fps"]["num"], 30_000);
        assert_eq!(json["durationSeconds"], 5.005);
    }

    #[test]
    fn normalize_probe_handles_audio_only_and_stills() {
        let audio_only = serde_json::json!({
            "streams": [{ "codec_type": "audio", "codec_name": "pcm_s16le", "sample_rate": "44100", "channels": 1 }],
            "format": { "format_name": "wav", "duration": "2.0" }
        });
        let probe = normalize_probe(&audio_only, "audio");
        assert_eq!(probe.media_type, "audio");
        assert!(!probe.has_video);
        assert_eq!(probe.sample_rate, Some(44_100));
        assert_eq!(probe.channels, Some(1));
        assert_eq!(
            probe.duration_frames(Some(FrameRateDto::new(24, 1))),
            Some(48)
        );

        let still = serde_json::json!({
            "streams": [{ "codec_type": "video", "codec_name": "png", "width": 800, "height": 600, "avg_frame_rate": "0/0", "r_frame_rate": "25/1" }],
            "format": { "format_name": "png" }
        });
        let probe = normalize_probe(&still, "image");
        // An image reports no duration but does report a frame rate.
        assert_eq!(probe.duration_seconds, None);
        assert_eq!(probe.fps, Some(FrameRateDto::new(25, 1)));
        assert_eq!(probe.media_type, "video");
    }

    #[test]
    fn media_types_follow_the_extension_table() {
        assert_eq!(media_type_for("MP4"), "video");
        assert_eq!(media_type_for("wav"), "audio");
        assert_eq!(media_type_for("webp"), "image");
        assert_eq!(media_type_for("srt"), "subtitle");
        assert_eq!(media_type_for("weird"), "video");
        assert_eq!(media_type_for_path(Path::new("/a/b/clip.mov")), "video");
    }

    #[test]
    fn peaks_reduce_samples_into_min_max_buckets() {
        let samples: Vec<f32> = vec![0.0, 0.5, -0.5, 1.0, -1.0, 0.25];
        let peaks = reduce_to_peaks(&samples, 3);
        assert_eq!(peaks.len(), 3);
        assert_eq!(peaks[0], [0.0, 0.5]);
        assert_eq!(peaks[1], [-0.5, 1.0]);
        assert_eq!(peaks[2], [-1.0, 0.25]);

        // More buckets than samples still yields exactly `buckets` finite entries.
        let peaks = reduce_to_peaks(&samples, 10);
        assert_eq!(peaks.len(), 10);
        assert!(peaks
            .iter()
            .all(|pair| pair[0].is_finite() && pair[1].is_finite()));

        // Silence and emptiness are not errors.
        assert_eq!(reduce_to_peaks(&[], 4), vec![[0.0, 0.0]; 4]);
        assert_eq!(reduce_to_peaks(&[0.0; 8], 2), vec![[0.0, 0.0]; 2]);
    }

    #[test]
    fn format_number_matches_format_filter_number_in_graph_ts() {
        // A representative spread of values the graph builder actually produces.
        assert_eq!(format_number(0.0, 6), "0");
        assert_eq!(format_number(1.0, 6), "1");
        assert_eq!(format_number(1.5, 6), "1.5");
        assert_eq!(format_number(1.0 / 3.0, 6), "0.333333");
        assert_eq!(format_number(10.0, 6), "10");
        assert_eq!(format_number(5.005, 6), "5.005");
        assert_eq!(format_number(0.5, 6), "0.5");
        assert_eq!(format_number(2.0, 6), "2");
        assert_eq!(format_number(-0.000001, 6), "-0.000001");
        // Negative zero must never reach FFmpeg as "-0".
        assert_eq!(format_number(-0.0, 6), "0");
        assert_eq!(format_number(-0.0000001, 6), "0");
        // Huge values stay in fixed notation rather than becoming "1e20".
        assert_eq!(format_number(1e20, 6), "100000000000000000000");
        // Non-finite values cannot be expressed; `graph.ts` throws, this builder clamps.
        assert_eq!(format_number(f64::NAN, 6), "0");
        assert_eq!(format_number(f64::INFINITY, 6), "0");
    }

    #[test]
    fn db_to_linear_matches_the_reference_values() {
        assert_eq!(db_to_linear(0.0), 1.0);
        assert_eq!(db_to_linear(-6.0), 0.501187);
        assert_eq!(db_to_linear(6.0), 1.995262);
        assert_eq!(db_to_linear(-96.0), 0.000016);
    }

    #[test]
    fn tail_lines_is_bounded() {
        let text = "one\ntwo\n\nthree\nfour\nfive\n";
        assert_eq!(tail_lines(text, 2), vec!["four", "five"]);
        assert_eq!(tail_lines(text, 99).len(), 5);
        assert!(tail_lines("", 3).is_empty());
    }

    #[test]
    fn find_binary_reports_a_clear_error_for_a_missing_tool() {
        let error = find_binary("creativelab-definitely-not-a-binary").unwrap_err();
        assert!(error.message.contains("was not found on PATH"), "{error}");
    }

    /// Integration smoke test: skipped (not failed) when FFmpeg is absent, matching the
    /// media package's convention.
    #[tokio::test]
    async fn probe_of_a_generated_fixture_round_trips() {
        let Ok(ffmpeg) = ffmpeg_path() else {
            eprintln!("skipping: ffmpeg not available");
            return;
        };
        let directory =
            std::env::temp_dir().join(format!("creativelab-probe-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let fixture = directory.join("fixture.mp4");
        let status = std::process::Command::new(ffmpeg)
            .args([
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x240:rate=30:duration=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
            ])
            .arg(&fixture)
            .status()
            .expect("ffmpeg must run");
        assert!(status.success(), "fixture generation failed");

        let probe = probe_file(&fixture).await.unwrap();
        assert_eq!(probe.media_type, "video");
        assert_eq!(probe.width, Some(320));
        assert_eq!(probe.height, Some(240));
        assert_eq!(probe.fps, Some(FrameRateDto::new(30, 1)));
        assert!(probe.has_audio);

        // Waveform + thumbnail + proxy all write into a caller-provided path.
        let peaks = generate_waveform(&fixture, &directory.join("wave.json"), 16)
            .await
            .unwrap();
        assert_eq!(peaks.len(), 16);
        assert!(directory.join("wave.json").is_file());

        let (width, height) = generate_thumbnail(&fixture, &directory.join("thumb.png"), 0.2, 160)
            .await
            .unwrap();
        assert_eq!(width, 160);
        assert_eq!(height, 120);

        let (proxy_width, _, bytes) = generate_proxy(&fixture, &directory.join("proxy.mp4"), 160)
            .await
            .unwrap();
        assert_eq!(proxy_width, 160);
        assert!(bytes > 0);

        let _ = std::fs::remove_dir_all(&directory);
    }
}
