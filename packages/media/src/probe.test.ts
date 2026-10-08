/**
 * ffprobe normalization tests — recorded JSON, no FFmpeg required.
 *
 * The fixtures below are trimmed copies of real `ffprobe -print_format json` output for an
 * H.264/AAC MP4 with display-matrix rotation, a 25 fps file with only `r_frame_rate` and a
 * legacy `tags.rotate`, an audio-only WAV, and an MP3 with cover art.
 */
import { describe, expect, it } from "vitest";
import { frameRate } from "@creativelab/core";
import { MediaError } from "./errors.js";
import {
  normalizeProbe,
  normalizeRotation,
  parseRationalFrameRate,
  probeDurationFrames,
} from "./probe.js";

const mp4WithRotation = {
  streams: [
    {
      index: 0,
      codec_name: "h264",
      codec_type: "video",
      profile: "High",
      width: 1920,
      height: 1080,
      pix_fmt: "yuv420p",
      avg_frame_rate: "30000/1001",
      r_frame_rate: "60/1",
      bit_rate: "5000000",
      duration: "5.005000",
      side_data_list: [
        { side_data_type: "Display Matrix", displaymatrix: "\n0000", rotation: -90 },
      ],
    },
    {
      index: 1,
      codec_name: "aac",
      codec_type: "audio",
      profile: "LC",
      sample_rate: "48000",
      channels: 2,
      channel_layout: "stereo",
      bit_rate: "192000",
      duration: "5.005000",
      tags: { language: "eng" },
    },
  ],
  format: {
    format_name: "mov,mp4,m4a,3gp,3g2,mj2",
    format_long_name: "QuickTime / MOV",
    duration: "5.005000",
    bit_rate: "5200000",
    nb_streams: 2,
  },
};

const legacyRotateTags = {
  streams: [
    {
      index: 0,
      codec_name: "h264",
      codec_type: "video",
      width: 640,
      height: 480,
      pix_fmt: "yuv420p",
      avg_frame_rate: "0/0",
      r_frame_rate: "25/1",
      tags: { rotate: "90" },
    },
  ],
  format: { format_name: "matroska,webm", duration: "2.000000" },
};

const audioOnlyWav = {
  streams: [
    {
      index: 0,
      codec_name: "pcm_s16le",
      codec_type: "audio",
      sample_rate: "44100",
      channels: 1,
      channel_layout: "mono",
      duration: "1.500000",
    },
  ],
  format: { format_name: "wav", duration: "1.500000", nb_streams: 1 },
};

const mp3WithCoverArt = {
  streams: [
    {
      index: 0,
      codec_name: "mp3",
      codec_type: "audio",
      sample_rate: "44100",
      channels: 2,
      duration: "3.000000",
    },
    {
      index: 1,
      codec_name: "mjpeg",
      codec_type: "video",
      width: 500,
      height: 500,
      disposition: { attached_pic: 1 },
      avg_frame_rate: "0/0",
      r_frame_rate: "90000/1",
    },
  ],
  format: { format_name: "mp3", duration: "3.000000" },
};

describe("normalizeProbe", () => {
  it("normalizes an MP4 with rotation side data", () => {
    const probe = normalizeProbe(mp4WithRotation, "/media/movie.mp4");
    expect(probe.container).toBe("mov,mp4,m4a,3gp,3g2,mj2");
    expect(probe.durationSeconds).toBeCloseTo(5.005, 6);
    expect(probe.streams).toHaveLength(2);

    const video = probe.video!;
    expect(video.type).toBe("video");
    expect(video.width).toBe(1920);
    expect(video.height).toBe(1080);
    expect(video.codec).toBe("h264");
    expect(video.profile).toBe("High");
    expect(video.pixFmt).toBe("yuv420p");
    expect(video.bitrate).toBe(5_000_000);
    // avg_frame_rate wins over r_frame_rate, and the rational survives exactly.
    expect(video.fps).toEqual({ num: 30_000, den: 1001 });
    expect(video.fps).toEqual(frameRate(30_000, 1001));
    // ffprobe reports -90 for a 90 degree clockwise display rotation.
    expect(video.rotation).toBe(270);
    expect(video.attachedPicture).toBe(false);

    const audio = probe.audio!;
    expect(audio.type).toBe("audio");
    expect(audio.codec).toBe("aac");
    expect(audio.sampleRate).toBe(48_000);
    expect(audio.channels).toBe(2);
    expect(audio.channelLayout).toBe("stereo");
    expect(audio.bitrate).toBe(192_000);
    expect(audio.language).toBe("eng");
    expect(audio.rotation).toBe(0);
    expect(audio.fps).toBeNull();
  });

  it("falls back to r_frame_rate and tags.rotate", () => {
    const probe = normalizeProbe(legacyRotateTags);
    expect(probe.video!.fps).toEqual({ num: 25, den: 1 });
    expect(probe.video!.rotation).toBe(90);
    expect(probe.audio).toBeUndefined();
    expect(probe.container).toBe("matroska,webm");
  });

  it("normalizes an audio-only file", () => {
    const probe = normalizeProbe(audioOnlyWav, "/media/voice.wav");
    expect(probe.container).toBe("wav");
    expect(probe.durationSeconds).toBeCloseTo(1.5, 6);
    expect(probe.video).toBeUndefined();
    expect(probe.audio!.codec).toBe("pcm_s16le");
    expect(probe.audio!.sampleRate).toBe(44_100);
    expect(probe.audio!.channels).toBe(1);
    expect(probe.audio!.bitrate).toBeNull();
    expect(probe.streams[0]!.fps).toBeNull();
  });

  it("does not treat cover art as a video stream", () => {
    const probe = normalizeProbe(mp3WithCoverArt);
    expect(probe.video).toBeUndefined();
    expect(probe.audio!.codec).toBe("mp3");
    const cover = probe.streams.find((stream) => stream.attachedPicture);
    expect(cover?.width).toBe(500);
    // 90000/1 is a timebase artefact of the still image; it is preserved, not trusted.
    expect(cover?.fps).toEqual({ num: 90_000, den: 1 });
  });

  it("computes frame counts from the probed duration", () => {
    const probe = normalizeProbe(mp4WithRotation);
    expect(probeDurationFrames(probe, frameRate(30_000, 1001))).toBe(150);
    expect(probeDurationFrames(normalizeProbe(audioOnlyWav), frameRate(25, 1))).toBe(38);
  });

  it("keeps the raw payload for the asset record", () => {
    const probe = normalizeProbe(mp4WithRotation);
    expect(probe.raw).toBe(mp4WithRotation);
    expect(probe.streams[0]!.raw).toBe(mp4WithRotation.streams[0]);
  });
});

describe("normalizeProbe rejection", () => {
  it("throws MediaError for invalid JSON shapes", () => {
    expect(() => normalizeProbe(null, "/media/x.mp4")).toThrow(MediaError);
    expect(() => normalizeProbe("not json")).toThrow(MediaError);
    expect(() => normalizeProbe([])).toThrow(MediaError);
    expect(() => normalizeProbe(42)).toThrow(MediaError);
  });

  it("throws MediaError for an empty document", () => {
    expect(() => normalizeProbe({}, "/media/empty.mp4")).toThrow(MediaError);
    expect(() => normalizeProbe({ streams: [] }, "/media/empty.mp4")).toThrow(
      /no streams or format/,
    );
    expect(() => normalizeProbe({ streams: [], format: {} })).toThrow(/no streams or format/);
  });

  it("throws MediaError for ffprobe's error payload", () => {
    expect(() =>
      normalizeProbe({ error: { code: -2, string: "No such file or directory" } }),
    ).toThrow(/Unreadable or unsupported media.*No such file or directory/);
    expect(() => normalizeProbe({ error: { code: -1 } })).toThrow(MediaError);
  });
});

describe("parseRationalFrameRate", () => {
  it("parses rational and decimal forms", () => {
    expect(parseRationalFrameRate("30000/1001")).toEqual({ num: 30_000, den: 1001 });
    expect(parseRationalFrameRate("25/1")).toEqual({ num: 25, den: 1 });
    expect(parseRationalFrameRate("29.97")).toEqual({ num: 2997, den: 100 });
    expect(parseRationalFrameRate(30)).toEqual({ num: 30, den: 1 });
  });

  it("returns null instead of throwing for unknown rates", () => {
    expect(parseRationalFrameRate("0/0")).toBeNull();
    expect(parseRationalFrameRate("0")).toBeNull();
    expect(parseRationalFrameRate("-1/1")).toBeNull();
    expect(parseRationalFrameRate("abc")).toBeNull();
    expect(parseRationalFrameRate("")).toBeNull();
    expect(parseRationalFrameRate(undefined)).toBeNull();
    expect(parseRationalFrameRate(Number.NaN)).toBeNull();
  });
});

describe("normalizeRotation", () => {
  it("normalizes signed values into [0, 360)", () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation("90")).toBe(90);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(-450)).toBe(270);
    expect(normalizeRotation(undefined)).toBe(0);
    expect(normalizeRotation("nonsense")).toBe(0);
  });
});
