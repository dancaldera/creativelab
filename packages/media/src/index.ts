/**
 * @creativelab/media — the FFmpeg/ffprobe pipeline.
 *
 * Probing, thumbnails, waveforms, proxies and timeline export. Nothing in this package
 * touches the network; every child process is spawned with an argument array (never a
 * shell), and every file it writes goes through a temp path or core's `atomicWriteFile`.
 *
 * Layering: this package depends on `@creativelab/core` and Node built-ins only.
 */
export {
  MediaError,
  ffmpegFailureMessage,
  outputLines,
  parseFfmpegError,
  tailLines,
} from "./errors.js";
export type { FfmpegFailureOptions, MediaErrorOptions } from "./errors.js";

export {
  ffmpegAvailable,
  ffmpegVersion,
  ffprobeAvailable,
  ffprobeVersion,
  resetBinaryResolution,
  resolveBinaryPath,
  resolveFfmpegPath,
  resolveFfprobePath,
} from "./binaries.js";
export type { MediaBinary } from "./binaries.js";

export { runProcess, runProcessBinary } from "./exec.js";
export type { BinaryProcessResult, ProcessResult, RunProcessOptions } from "./exec.js";

export {
  accumulateProgress,
  parseClock,
  parseProgressLine,
  runFfmpeg,
  runFfprobe,
} from "./ffmpeg.js";
export type {
  FfmpegProgress,
  FfmpegProgressOptions,
  FfmpegProgressState,
  FfmpegResult,
  RunFfprobeOptions,
} from "./ffmpeg.js";

export {
  normalizeProbe,
  normalizeRotation,
  parseRationalFrameRate,
  probeDurationFrames,
  probeMedia,
} from "./probe.js";
export type {
  AudioStreamInfo,
  MediaProbe,
  MediaStreamInfo,
  MediaStreamType,
  ProbeMediaOptions,
  VideoStreamInfo,
} from "./probe.js";

export { extractThumbnail, thumbnailScaleFilter } from "./thumbnail.js";
export type { ExtractThumbnailOptions, ThumbnailFormat, ThumbnailResult } from "./thumbnail.js";

export {
  computeWaveformPeaks,
  extractWaveform,
  extractWaveformFile,
  pcmF32ToSamples,
  waveformCachePath,
  waveformPeaksToInterleaved,
  DEFAULT_WAVEFORM_SAMPLE_RATE,
} from "./waveform.js";
export type {
  ExtractWaveformFileOptions,
  ExtractWaveformOptions,
  WaveformBucket,
  WaveformData,
  WaveformFileResult,
} from "./waveform.js";

export {
  createProxy,
  proxyScaleFilter,
  DEFAULT_PROXY_CRF,
  DEFAULT_PROXY_MAX_WIDTH,
  PROXY_EVEN_SCALE_FILTER,
} from "./proxy.js";
export type { CreateProxyOptions, ProxyResult } from "./proxy.js";

export {
  buildAtempoChain,
  buildFilterGraph,
  cropStage,
  formatFilterNumber,
  opacityStage,
  rotationStage,
} from "./graph.js";
export type {
  AssetResolver,
  BuildFilterGraphOptions,
  ExportFilterGraph,
  GraphAssetInfo,
} from "./graph.js";

export { buildExportGraph, defaultExportName, renderTimeline } from "./export.js";
export type { RenderProgress, RenderTimelineOptions, RenderTimelineResult } from "./export.js";
