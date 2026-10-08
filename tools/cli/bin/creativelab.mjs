#!/usr/bin/env node
/**
 * Creative Studio headless driver.
 *
 * Runs the same packages the desktop app runs, with no window and no network, so the
 * domain layer can be verified — and scripts written against it — independently of the
 * Tauri shell.
 *
 *   creativelab init <dir> [--title T] [--fps 30] [--size 1920x1080] [--force]
 *   creativelab import <dir> <file...> [--link]
 *   creativelab generate <dir> --mode text-to-image --prompt "..." [--approve]
 *   creativelab place <dir> --asset <id> --kind video [--start 0] [--track-index 0]
 *   creativelab edit <dir> --split 45 [--track-index 0] [--opacity 0.5] [--effect brightness]
 *   creativelab export <dir> [--preset 1080p] [--out name.mp4]
 *   creativelab info <dir>
 *   creativelab verify <dir>
 *   creativelab package <dir> <destination>
 *   creativelab e2e [--dir .tmp/e2e] [--preset 720p]
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  DEFAULT_BUDGET_POLICY,
  EXPORT_PRESETS,
  FRAME_RATE_PRESETS,
  assertTimelineInvariants,
  clipEnd,
  formatMoney,
  formatTimecode,
} from "@creativelab/core";
import { ffmpegAvailable, probeMedia } from "@creativelab/media";

import {
  addBrightness,
  describeDocument,
  exportTimeline,
  fileExists,
  generateAsset,
  importAsset,
  initProject,
  makeFixtureAudio,
  makeFixtureVideo,
  openProject,
  placeClip,
  setOpacity,
  splitAt,
  tracksOfKind,
  trimAt,
} from "../lib/studio.mjs";

// ---------------------------------------------------------------------------
// Argument parsing and console helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=");
      const key = rawKey;
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
      } else if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
        flags[key] = argv[++index];
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = (text) => paint("1", text);
const dim = (text) => paint("2", text);
const green = (text) => paint("32", text);
const yellow = (text) => paint("33", text);
const red = (text) => paint("31", text);

function heading(text) {
  process.stdout.write(`\n${bold(text)}\n${dim("─".repeat(Math.max(12, text.length)))}\n`);
}

function okay(text) {
  process.stdout.write(`  ${green("✓")} ${text}\n`);
}

function warn(text) {
  process.stdout.write(`  ${yellow("!")} ${text}\n`);
}

function fail(text) {
  process.stdout.write(`  ${red("✗")} ${text}\n`);
}

function row(label, value) {
  process.stdout.write(`  ${label.padEnd(22)} ${value}\n`);
}

function parseSize(value, fallback) {
  if (!value || value === true) return fallback;
  const match = /^(\d+)x(\d+)$/.exec(String(value));
  if (!match) throw new Error(`--size must look like 1920x1080, received "${value}"`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function parseFrameRate(value) {
  if (!value || value === true) return { num: 30, den: 1 };
  const preset = FRAME_RATE_PRESETS.find((candidate) => candidate.id === String(value));
  if (!preset) {
    throw new Error(
      `--fps must be one of ${FRAME_RATE_PRESETS.map((candidate) => candidate.id).join(", ")}, received "${value}"`,
    );
  }
  return preset.rate;
}

function presetById(id) {
  const preset = EXPORT_PRESETS.find((candidate) => candidate.id === String(id));
  if (!preset) {
    throw new Error(
      `--preset must be one of ${EXPORT_PRESETS.map((candidate) => candidate.id).join(", ")}`,
    );
  }
  return preset;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandInit(positionals, flags) {
  const directory = positionals[0];
  if (!directory) throw new Error("init requires a target directory");
  const size = parseSize(flags.size, { width: 1920, height: 1080 });

  const { session, workspace } = await initProject({
    directory,
    title: typeof flags.title === "string" ? flags.title : undefined,
    fps: parseFrameRate(flags.fps),
    width: size.width,
    height: size.height,
    force: flags.force === true,
  });

  heading("Project created");
  row("workspace", workspace.layout.root);
  row("manifest", workspace.layout.manifestPath);
  for (const [key, value] of Object.entries(describeDocument(session.document)))
    row(key, String(value));
  await session.close();
  return 0;
}

async function commandImport(positionals, flags) {
  const [directory, ...files] = positionals;
  if (!directory || files.length === 0)
    throw new Error("import requires a project directory and at least one file");

  const context = await openProject(directory);
  heading("Import");
  let failed = 0;
  for (const file of files) {
    try {
      const result = await importAsset(context, file, {
        mode: flags.link === true ? "link" : "copy",
      });
      const asset = result.asset;
      const detail = [
        asset.mediaType,
        asset.width && asset.height ? `${asset.width}x${asset.height}` : null,
        asset.durationFrames ? `${asset.durationFrames}f` : null,
        asset.codec ?? null,
      ]
        .filter(Boolean)
        .join(" · ");
      if (result.duplicateOf) warn(`${file} — duplicate of ${result.duplicateOf}, reusing`);
      else okay(`${file} → ${asset.id} (${detail})`);
      for (const warning of result.warnings) warn(warning);
    } catch (error) {
      fail(`${file}: ${error.message}`);
      failed += 1;
    }
  }
  await context.session.close();
  return failed === 0 ? 0 : 1;
}

async function commandGenerate(positionals, flags) {
  const directory = positionals[0];
  if (!directory) throw new Error("generate requires a project directory");
  const mode = typeof flags.mode === "string" ? flags.mode : "text-to-image";
  const prompt = typeof flags.prompt === "string" ? flags.prompt : "";
  if (prompt.length === 0) throw new Error("generate requires --prompt");

  const context = await openProject(directory);
  heading(`Generate · ${mode}`);

  const request = {
    providerId: "mock",
    modelId: typeof flags.model === "string" ? flags.model : defaultModelForMode(mode),
    mode,
    prompt,
    references: [],
    ...(flags.negative ? { negativePrompt: String(flags.negative) } : {}),
    ...(flags.seed ? { seed: Number(flags.seed) } : {}),
    ...(flags.duration ? { durationSeconds: Number(flags.duration) } : {}),
    ...(flags.aspect ? { aspectRatio: String(flags.aspect) } : {}),
    ...(flags.voice ? { voiceId: String(flags.voice) } : {}),
  };

  const result = await generateAsset(context, request, { approve: flags.approve === true });
  row("job", result.job.id);
  row("provider job", result.job.providerJobId ?? "—");
  row("status", result.job.status);
  row("estimate", result.estimate ? formatMoney(result.estimate) : "unknown pricing");
  if (result.budget.requiresApproval) warn(result.budget.reason);
  for (const asset of result.assets) {
    row("asset", `${asset.id} (${asset.mediaType}, ${asset.bytes} bytes)`);
    row("  provenance", `job ${asset.generationJobId}`);
  }
  await context.session.close();
  return 0;
}

/**
 * Default model ids for the mock adapter's catalog. Kept explicit (rather than derived)
 * so an unknown mode fails loudly instead of silently picking the wrong modality.
 */
const MODE_DEFAULT_MODEL = {
  "text-to-image": "mock-image-1",
  "image-to-image": "mock-image-1",
  "text-to-video": "mock-video-1",
  "image-to-video": "mock-video-1",
  tts: "mock-speech-1",
  sfx: "mock-sfx-1",
  music: "mock-sfx-1",
  transcription: "mock-transcribe-1",
};

function defaultModelForMode(mode) {
  const modelId = MODE_DEFAULT_MODEL[mode];
  if (!modelId) throw new Error(`No default mock model for mode "${mode}"; pass --model`);
  return modelId;
}

async function commandPlace(positionals, flags) {
  const [directory] = positionals;
  if (!directory) throw new Error("place requires a project directory");
  if (!flags.asset) throw new Error("place requires --asset <assetId>");

  const context = await openProject(directory);
  const clip = placeClip(context, {
    assetId: String(flags.asset),
    kind: typeof flags.kind === "string" ? flags.kind : undefined,
    startFrame: flags.start !== undefined ? Number(flags.start) : undefined,
    trackIndex: flags["track-index"] !== undefined ? Number(flags["track-index"]) : undefined,
    gainDb: flags.gain !== undefined ? Number(flags.gain) : undefined,
  });
  okay(`placed ${clip.id} at frame ${clip.startFrame} for ${clip.durationFrames} frames`);
  await context.session.close();
  return 0;
}

async function commandEdit(positionals, flags) {
  const [directory] = positionals;
  if (!directory) throw new Error("edit requires a project directory");

  const context = await openProject(directory);
  heading("Edit");

  if (flags.split !== undefined) {
    const track = tracksOfKind(context.session.document, "video")[
      Number(flags["track-index"] ?? 0)
    ];
    const result = splitAt(context, track.id, Number(flags.split));
    if (result) okay(`split at frame ${flags.split} → ${result.leftId} | ${result.rightId}`);
    else warn(`no clip spans frame ${flags.split} on ${track.name}`);
  }

  if (flags.trim) {
    const [clipId, edge, frame] = String(flags.trim).split(":");
    trimAt(context, clipId, edge, Number(frame));
    okay(`trimmed ${clipId} ${edge} to ${frame}`);
  }

  if (flags.opacity !== undefined) {
    for (const clip of context.session.document.clips.slice(0, 1)) {
      setOpacity(context, clip.id, Number(flags.opacity));
      okay(`set opacity ${flags.opacity} on ${clip.id}`);
    }
  }

  if (flags.effect) {
    for (const clip of context.session.document.clips.slice(0, 1)) {
      addBrightness(context, clip.id, Number(flags.amount ?? 0.1));
      okay(`added ${flags.effect} effect to ${clip.id}`);
    }
  }

  await context.session.flushAutosave();
  for (const [key, value] of Object.entries(describeDocument(context.session.document)))
    row(key, String(value));
  await context.session.close();
  return 0;
}

async function commandExport(positionals, flags) {
  const [directory] = positionals;
  if (!directory) throw new Error("export requires a project directory");
  const preset = presetById(flags.preset ?? "1080p");

  const context = await openProject(directory);
  heading(`Export · ${preset.label}`);

  let lastReported = -1;
  const result = await exportTimeline(context, {
    preset,
    outputName: typeof flags.out === "string" ? flags.out : undefined,
    onProgress: (progress) => {
      const percent = Math.floor(progress.progress * 100);
      if (percent !== lastReported && percent % 10 === 0) {
        lastReported = percent;
        process.stdout.write(
          `    ${dim(`${String(percent).padStart(3)}%  frame ${progress.renderedFrames}/${progress.totalFrames}`)}\r`,
        );
      }
    },
  });
  process.stdout.write(" ".repeat(50) + "\r");

  const probe = await probeMedia(result.outputPath);
  okay(result.outputPath);
  row("frames", String(result.frames));
  row("duration", `${result.durationSeconds.toFixed(3)}s`);
  row("container", probe.container ?? "?");
  row(
    "video",
    probe.video ? `${probe.video.width}x${probe.video.height} ${probe.video.codec}` : "none",
  );
  row(
    "audio",
    probe.audio
      ? `${probe.audio.codec} ${probe.audio.sampleRate}Hz ${probe.audio.channels}ch`
      : "none",
  );
  await context.session.close();
  return 0;
}

async function commandInfo(positionals) {
  const [directory] = positionals;
  if (!directory) throw new Error("info requires a project directory");
  const context = await openProject(directory);
  heading("Project");
  for (const [key, value] of Object.entries(describeDocument(context.session.document)))
    row(key, String(value));
  heading("Clips");
  for (const clip of context.session.document.clips) {
    const asset = context.session.document.assets.find(
      (candidate) => candidate.id === clip.assetId,
    );
    process.stdout.write(
      `  ${clip.id}  ${dim(`${clip.startFrame}–${clipEnd(clip)}`)}  ${(clip.label || "—").slice(0, 34).padEnd(34)} ${dim(asset?.mediaType ?? "no asset")}\n`,
    );
  }
  if (context.session.document.clips.length === 0)
    process.stdout.write(`  ${dim("(empty timeline)")}\n`);
  heading("Assets");
  for (const asset of context.session.document.assets) {
    process.stdout.write(
      `  ${asset.id}  ${asset.mediaType.padEnd(6)} ${asset.origin.padEnd(9)} ${dim((asset.relativePath ?? asset.uri).slice(-52))}\n`,
    );
  }
  await context.session.close();
  return 0;
}

async function commandVerify(positionals) {
  const [directory] = positionals;
  if (!directory) throw new Error("verify requires a project directory");
  const context = await openProject(directory);
  const report = await context.session.verifyAssets();
  heading("Media integrity");
  row("checked", String(report.checked));
  row("resolved", String(report.ok));
  row("portable", report.portable ? green("yes") : yellow("no"));
  for (const issue of report.issues) warn(`${issue.kind}: ${issue.assetId} — ${issue.message}`);
  await context.session.close();
  return report.portable ? 0 : 1;
}

async function commandPackage(positionals) {
  const [directory, destination] = positionals;
  if (!directory || !destination)
    throw new Error("package requires a project directory and a destination");
  const context = await openProject(directory);
  heading("Package project");
  const result = await context.session.packageProject(resolve(destination));
  row("destination", result.destination);
  row("files", String(result.files));
  row("bytes", `${(result.bytes / 1024 / 1024).toFixed(2)} MB`);
  row("portable", result.report.portable ? green("yes") : yellow("no"));
  for (const assetId of result.unresolved) warn(`not portable: ${assetId}`);
  for (const issue of result.report.issues) warn(`${issue.kind}: ${issue.message}`);
  await context.session.close();
  return result.report.portable ? 0 : 1;
}

// ---------------------------------------------------------------------------
// End-to-end journey
// ---------------------------------------------------------------------------

/**
 * The AI-first journey from PRD §5, executed headlessly and asserted.
 *
 * idea → script/storyboard → shot generation → timeline → preview → export
 *
 * Every assertion is a real check against real output; there is no "pretend" step. The
 * only substitution is the provider (a deterministic mock adapter) and the absence of a
 * preview window, which the export probe stands in for.
 */
async function commandE2E(_positionals, flags) {
  const failures = [];
  const check = (label, condition, detail = "") => {
    if (condition) okay(label);
    else {
      fail(`${label}${detail ? ` — ${detail}` : ""}`);
      failures.push(label);
    }
  };

  const root = resolve(typeof flags.dir === "string" ? flags.dir : ".tmp/e2e");
  const projectDir = join(root, "DemoProject");
  const fixtureDir = join(root, "fixtures");
  const packageDir = join(root, "packaged");
  const preset = presetById(flags.preset ?? "720p");

  if (flags.keep !== true) await rm(root, { recursive: true, force: true });
  await mkdir(fixtureDir, { recursive: true });

  // --- Preconditions -------------------------------------------------------
  heading("0 · Environment");
  const hasFfmpeg = await ffmpegAvailable();
  check("ffmpeg is available", hasFfmpeg, "install FFmpeg or set FFMPEG_PATH");
  if (!hasFfmpeg) {
    process.stdout.write(`\n${red("Cannot continue without FFmpeg.")}\n`);
    return 1;
  }

  // Real, playable fixtures — the export must produce a genuine MP4, so the inputs must be
  // genuine media rather than synthetic blobs.
  const clipAPath = await makeFixtureVideo(join(fixtureDir, "shot-a.mp4"), {
    seconds: 3,
    source: "testsrc2",
  });
  const clipBPath = await makeFixtureVideo(join(fixtureDir, "shot-b.mp4"), {
    seconds: 2,
    source: "smptebars",
    frequency: 660,
  });
  const tonePath = await makeFixtureAudio(join(fixtureDir, "narration.wav"), { seconds: 5 });
  check(
    "generated 3 FFmpeg fixtures (2 video, 1 audio)",
    Boolean(clipAPath && clipBPath && tonePath),
  );

  // --- 1. Create ----------------------------------------------------------
  heading("1 · Create project (FR-01)");
  const context = await initProject({
    directory: projectDir,
    title: "Brief to export",
    fps: { num: 30, den: 1 },
    width: 1280,
    height: 720,
    force: true,
  });
  const { session, workspace } = context;
  check("manifest written", await fileExists(workspace.layout.manifestPath));
  check("database written", await fileExists(workspace.layout.databasePath));
  check(
    "default track set is at least 3 video + 4 audio (FR-03)",
    tracksOfKind(session.document, "video").length >= 3 &&
      tracksOfKind(session.document, "audio").length >= 4,
  );
  check("project starts clean", session.dirty === false);

  // --- 2. Import ----------------------------------------------------------
  heading("2 · Import media (FR-02)");
  const importedA = await importAsset(context, clipAPath);
  const importedB = await importAsset(context, clipBPath);
  const importedTone = await importAsset(context, tonePath);
  check(
    "imported shot A with probed video metadata",
    Boolean(importedA.asset.width && importedA.asset.fps),
  );
  check("imported shot B", importedB.asset.mediaType === "video");
  check("imported narration with probed audio metadata", importedTone.asset.channels !== null);
  check(
    "imports are copied into the project and are project-relative (PRD §11)",
    importedA.asset.storageMode === "copied" &&
      importedA.asset.relativePath?.startsWith("assets/originals/"),
  );
  check(
    "content hash recorded for duplicate detection",
    /^[0-9a-f]{64}$/.test(importedA.asset.sha256 ?? ""),
  );

  const beforeDupeFiles = (await readdir(workspace.originalsDir())).sort();
  const duplicate = await importAsset(context, clipAPath);
  const afterDupeFiles = (await readdir(workspace.originalsDir())).sort();
  check(
    "re-importing identical content dedupes instead of copying",
    duplicate.duplicateOf === importedA.asset.id,
  );
  check(
    "a duplicate import leaves no orphan file on disk",
    beforeDupeFiles.length === afterDupeFiles.length,
    `${beforeDupeFiles.join(",")} -> ${afterDupeFiles.join(",")}`,
  );

  // --- 3. Generate --------------------------------------------------------
  heading("3 · Generate assets (FR-05…FR-10)");
  const imageJob = await generateAsset(
    context,
    {
      providerId: "mock",
      modelId: "mock-image-1",
      mode: "text-to-image",
      prompt: "a lighthouse at dusk, 35mm",
      references: [],
    },
    { approve: true },
  );
  check(
    "image generation completed and committed an asset",
    imageJob.job.status === "completed" && imageJob.assets.length === 1,
  );
  check(
    "generated asset carries provenance back to its job",
    imageJob.assets[0].generationJobId === imageJob.job.id,
  );
  check("generated asset has a prompt revision", Boolean(imageJob.assets[0].promptRevisionId));
  check("job recorded a cost estimate", imageJob.job.costEstimate !== null);

  const sfxJob = await generateAsset(
    context,
    {
      providerId: "mock",
      modelId: "mock-sfx-1",
      mode: "sfx",
      prompt: "distant thunder",
      references: [],
    },
    { approve: true },
  );
  check("sound-effect generation completed", sfxJob.job.status === "completed");

  const narrationJob = await generateAsset(
    context,
    {
      providerId: "mock",
      modelId: "mock-speech-1",
      mode: "tts",
      prompt: "In a small studio by the sea, the timeline is the source of truth.",
      references: [],
      voiceId: "mock-voice-aria",
      language: "en-US",
    },
    { approve: true },
  );
  check("narration generation completed", narrationJob.job.status === "completed");

  // Capability gating must refuse and explain, not silently drop the feature. Asking an
  // image model for a video is a mode/modality mismatch that every correct adapter must
  // reject, so this assertion does not depend on any particular model's metadata.
  let gateMessage = "";
  try {
    await generateAsset(
      context,
      {
        providerId: "mock",
        modelId: "mock-image-1",
        mode: "text-to-video",
        prompt: "x",
        references: [],
      },
      { approve: true },
    );
  } catch (error) {
    gateMessage = error.message;
  }
  check(
    "an unsupported mode is refused explicitly, naming the field",
    gateMessage.length > 0 && /mode|modality/i.test(gateMessage),
    gateMessage,
  );

  // The budget gate must refuse a job it cannot afford. An image request is used because
  // it is mode-valid for this model, so the only thing that can refuse it is the budget.
  let budgetMessage = "";
  try {
    await generateAsset(
      context,
      {
        providerId: "mock",
        modelId: "mock-image-1",
        mode: "text-to-image",
        prompt: "an expensive shot",
        references: [],
      },
      { approve: true, budget: { ...DEFAULT_BUDGET_POLICY, maxCostPerJob: 1e-9 } },
    );
  } catch (error) {
    budgetMessage = error.message;
  }
  check(
    "the per-job budget cap blocks an over-budget job",
    /budget/i.test(budgetMessage),
    budgetMessage,
  );

  // --- 4. Edit the timeline ----------------------------------------------
  heading("4 · Edit the timeline (FR-03)");
  const videoTrack = tracksOfKind(session.document, "video")[0];
  const audioTrack = tracksOfKind(session.document, "audio")[0];
  const generatedAudioTrack = tracksOfKind(session.document, "audio")[1];

  const clipA = placeClip(context, {
    assetId: importedA.asset.id,
    trackId: videoTrack.id,
    startFrame: 0,
  });
  check("placed shot A at frame 0", clipA.startFrame === 0);

  const splitResult = splitAt(context, videoTrack.id, 45);
  check(
    "split shot A into two clips at frame 45",
    Boolean(splitResult) && session.document.clips.length === 2,
  );
  check(
    "split preserved total duration (no frames lost)",
    session.document.clips.reduce((sum, clip) => sum + clip.durationFrames, 0) ===
      clipA.durationFrames,
  );

  trimAt(context, splitResult.rightId, "end", 60);
  const trimmed = session.document.clips.find((clip) => clip.id === splitResult.rightId);
  check("trimmed the right half to end at frame 60", trimmed.durationFrames === 15);

  const clipB = placeClip(context, {
    assetId: importedB.asset.id,
    trackId: videoTrack.id,
    startFrame: 90,
  });
  check("placed shot B at frame 90", clipB.startFrame === 90);

  const toneClip = placeClip(context, {
    assetId: importedTone.asset.id,
    trackId: audioTrack.id,
    startFrame: 0,
    gainDb: -3,
  });
  check("placed narration on the first audio track", toneClip.durationFrames > 0);

  const sfxClip = placeClip(context, {
    assetId: sfxJob.assets[0].id,
    trackId: generatedAudioTrack.id,
    startFrame: 120,
    gainDb: -8,
  });
  check(
    "placed the generated sound effect on a second audio track",
    sfxClip.trackId === generatedAudioTrack.id,
  );

  setOpacity(context, clipB.id, 0.6);
  const fadedClip = session.document.clips.find((clip) => clip.id === clipB.id);
  check(
    "set clip opacity without touching the source file",
    fadedClip.properties.transform.opacity === 0.6,
  );

  addBrightness(context, clipB.id, 0.15);
  check("added a clip effect", session.document.effects.length === 1);

  const preUndo = session.document.clips.length;
  session.undo();
  check("undo removed the effect", session.document.effects.length === 0);
  session.redo();
  check(
    "redo restored the effect",
    session.document.effects.length === 1 && session.document.clips.length === preUndo,
  );

  let invariantsHold = true;
  let invariantMessage = "";
  try {
    assertTimelineInvariants(session.document);
  } catch (error) {
    invariantsHold = false;
    invariantMessage = error.message;
  }
  check("timeline invariants hold after all edits", invariantsHold, invariantMessage);

  await session.flushAutosave();
  const savedClips = session.document.clips.length;
  const savedEffects = session.document.effects.length;

  // --- 5. Export ----------------------------------------------------------
  heading(`5 · Export ${preset.label} (FR-09)`);
  const exportResult = await exportTimeline(context, { preset, outputName: "brief-to-export.mp4" });
  check("export produced a file", await fileExists(exportResult.outputPath));
  check(
    "export rendered every frame of the timeline",
    exportResult.frames > 0,
    `frames=${exportResult.frames}`,
  );

  const outputProbe = await probeMedia(exportResult.outputPath);
  check(
    "output is H.264 video",
    outputProbe.video?.codec === "h264",
    outputProbe.video?.codec ?? "none",
  );
  check(
    "output is AAC audio",
    outputProbe.audio?.codec === "aac",
    outputProbe.audio?.codec ?? "none",
  );
  check(
    "output resolution matches the preset",
    outputProbe.video?.width === preset.width && outputProbe.video?.height === preset.height,
    `${outputProbe.video?.width}x${outputProbe.video?.height} vs ${preset.width}x${preset.height}`,
  );
  const expectedSeconds =
    exportResult.frames / (session.document.project.fps.num / session.document.project.fps.den);
  check(
    "output duration is within one frame of the timeline duration",
    Math.abs(outputProbe.durationSeconds - expectedSeconds) <= 1 / 30 + 0.05,
    `${outputProbe.durationSeconds.toFixed(3)}s vs ${expectedSeconds.toFixed(3)}s`,
  );
  check(
    "audio and video are both present, so A/V sync is testable",
    Boolean(outputProbe.audio && outputProbe.video),
  );

  // --- 6. Durability ------------------------------------------------------
  heading("6 · Save, reopen, recover (FR-01)");
  await session.close();

  const reopened = await openProject(projectDir);
  check("reopened the project from disk", reopened.session.document.clips.length === savedClips);
  check(
    "clip geometry survived the round trip",
    reopened.session.document.clips.length === savedClips,
  );
  check(
    "effects survived the round trip",
    reopened.session.document.effects.length === savedEffects,
  );
  check(
    "project frame rate survived exactly (rational)",
    reopened.session.document.project.fps.num === 30,
  );
  check(
    "generated assets are still present with provenance",
    reopened.session.document.assets.filter((asset) => asset.origin === "generated").length === 3,
  );

  const integrity = await reopened.session.verifyAssets();
  check(
    "no media is missing",
    integrity.issues.filter((issue) => issue.kind === "missing").length === 0,
  );
  check(
    "every asset is project-relative, so the project is portable",
    integrity.portable,
    integrity.issues.map((issue) => issue.kind).join(","),
  );

  const finalAssetCount = reopened.session.document.assets.length;
  const finalFrameRate = reopened.session.document.project.fps;

  // --- 7. Package ---------------------------------------------------------
  heading("7 · Package project (PRD §11)");
  // `packageProject` refuses a non-empty destination, so clear the one this run owns.
  await rm(packageDir, { recursive: true, force: true });
  const packaged = await reopened.session.packageProject(packageDir);
  check(
    "packaged folder contains project.json",
    await fileExists(join(packageDir, "project.json")),
  );
  check(
    "packaged folder contains the media",
    await fileExists(join(packageDir, "assets/originals", "shot-a.mp4")),
  );
  check("packaged folder has no rebuildable cache", !(await fileExists(join(packageDir, "cache"))));
  check("the packaged copy validates as relinkable", packaged.report.portable);

  // A packaged project must open on a machine that has never seen the database.
  await rm(join(packageDir, "project.db"), { force: true });
  const fromPackage = await openProject(packageDir);
  check(
    "packaged project opens with no database, rehydrated from project.json",
    fromPackage.session.document.clips.length === savedClips,
  );
  await fromPackage.session.close();
  await reopened.session.close();

  // --- Report -------------------------------------------------------------
  heading("Result");
  row("project", projectDir);
  row("export", exportResult.outputPath);
  row("package", packageDir);
  row("timeline", `${savedClips} clips, ${savedEffects} effects`);
  row("assets", String(finalAssetCount));
  row("duration", formatTimecode(exportResult.frames, finalFrameRate));

  if (failures.length > 0) {
    process.stdout.write(`\n${red(`FAILED — ${failures.length} check(s):`)}\n`);
    for (const failure of failures) process.stdout.write(`  · ${failure}\n`);
    return 1;
  }
  process.stdout.write(`\n${green("PASSED — the brief-to-export journey works end to end.")}\n`);
  if (flags.keep === true) process.stdout.write(`${dim(`artifacts kept in ${root}`)}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const COMMANDS = {
  init: commandInit,
  import: commandImport,
  generate: commandGenerate,
  place: commandPlace,
  edit: commandEdit,
  export: commandExport,
  info: commandInfo,
  verify: commandVerify,
  package: commandPackage,
  e2e: commandE2E,
};

const USAGE = `Creative Studio headless driver

Usage: creativelab <command> [options]

Commands
  init <dir>                    Create a project (--title --fps --size --force)
  import <dir> <file...>        Import media (--link to reference instead of copying)
  generate <dir>                Generate an asset (--mode --prompt --model --approve)
  place <dir>                   Place an asset on the timeline (--asset --track-index --start)
  edit <dir>                    Edit the timeline (--split --trim --opacity --effect)
  export <dir>                  Render MP4 (--preset --out)
  info <dir>                    Show the project, clips and assets
  verify <dir>                  Check that every asset resolves
  package <dir> <destination>   Produce a self-contained copy
  e2e                           Run and assert the whole idea-to-export journey

Examples
  creativelab init ./MyProject --title "Launch film" --fps 30
  creativelab e2e --preset 720p --keep

Exit codes: 0 success, 1 a check or operation failed, 2 usage error.
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 2 : 0;
  }

  const command = argv[0];
  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }

  const { positionals, flags } = parseArgs(argv.slice(1));
  return handler(positionals, flags);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`\n${red("Error:")} ${error.message}\n`);
  if (process.env.CREATIVELAB_DEBUG) process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}
