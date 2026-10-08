/**
 * Waveform bucket maths — pure, no FFmpeg.
 *
 * The properties that matter for a UI envelope: buckets tile the input exactly, silence is
 * `0` and never `NaN`, and an input shorter than the bucket count still yields exactly
 * `buckets` entries.
 */
import { describe, expect, it } from "vitest";
import { MediaError } from "./errors.js";
import { computeWaveformPeaks, pcmF32ToSamples, waveformPeaksToInterleaved } from "./waveform.js";

/** 440 Hz sine at 8 kHz, the same shape the integration test decodes from FFmpeg. */
function sine(sampleCount: number, frequency: number, sampleRate: number): Float32Array {
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  }
  return samples;
}

describe("computeWaveformPeaks", () => {
  it("returns min and max per bucket for a sine wave", () => {
    const samples = sine(1000, 50, 1000);
    const peaks = computeWaveformPeaks(samples, 10);
    expect(peaks).toHaveLength(10);
    for (let bucket = 0; bucket < 10; bucket += 1) {
      const start = Math.floor((bucket * 1000) / 10);
      const end = Math.floor(((bucket + 1) * 1000) / 10);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let index = start; index < end; index += 1) {
        const value = samples[index]!;
        if (value < min) min = value;
        if (value > max) max = value;
      }
      expect(peaks[bucket]!.min).toBeCloseTo(min, 6);
      expect(peaks[bucket]!.max).toBeCloseTo(max, 6);
      expect(peaks[bucket]!.min).toBeLessThan(0);
      expect(peaks[bucket]!.max).toBeGreaterThan(0);
    }
  });

  it("reports silence as zeros, never NaN", () => {
    const peaks = computeWaveformPeaks(new Float32Array(4096), 16);
    expect(peaks).toHaveLength(16);
    for (const peak of peaks) {
      expect(peak.min).toBe(0);
      expect(peak.max).toBe(0);
      expect(Number.isNaN(peak.min)).toBe(false);
      expect(Number.isNaN(peak.max)).toBe(false);
    }
  });

  it("maps one sample per bucket when the counts match exactly", () => {
    const samples = Float32Array.from([-1, -0.5, 0, 0.5, 1]);
    expect(computeWaveformPeaks(samples, 5)).toEqual([
      { min: -1, max: -1 },
      { min: -0.5, max: -0.5 },
      { min: 0, max: 0 },
      { min: 0.5, max: 0.5 },
      { min: 1, max: 1 },
    ]);
  });

  it("tiles the samples with floor(i*n/buckets) bounds when there are fewer samples than buckets", () => {
    const samples = Float32Array.from([0.25, -0.25, 0.75]);
    const peaks = computeWaveformPeaks(samples, 5);
    expect(peaks).toHaveLength(5);
    // Bounds are floor(i*3/5) and floor((i+1)*3/5): [0,0) [0,1) [1,1) [1,2) [2,3).
    expect(peaks).toEqual([
      { min: 0, max: 0 },
      { min: 0.25, max: 0.25 },
      { min: 0, max: 0 },
      { min: -0.25, max: -0.25 },
      { min: 0.75, max: 0.75 },
    ]);
    for (const peak of peaks) {
      expect(Number.isFinite(peak.min)).toBe(true);
      expect(Number.isFinite(peak.max)).toBe(true);
    }
  });

  it("handles empty and single-sample input", () => {
    expect(computeWaveformPeaks(new Float32Array(0), 4)).toEqual([
      { min: 0, max: 0 },
      { min: 0, max: 0 },
      { min: 0, max: 0 },
      { min: 0, max: 0 },
    ]);
    expect(computeWaveformPeaks(Float32Array.from([0.5]), 1)).toEqual([{ min: 0.5, max: 0.5 }]);
    expect(computeWaveformPeaks(Float32Array.from([0.5]), 3)).toEqual([
      { min: 0, max: 0 },
      { min: 0, max: 0 },
      { min: 0.5, max: 0.5 },
    ]);
  });

  it("keeps every value inside [-1, 1] and survives NaN samples", () => {
    const samples = Float32Array.from([1.5, -2, Number.NaN, 0.5]);
    const peaks = computeWaveformPeaks(samples, 2);
    expect(peaks[0]).toEqual({ min: -1, max: 1 });
    // A NaN neighbour cannot affect a bucket that also contains real samples.
    expect(peaks[1]).toEqual({ min: 0.5, max: 0.5 });
    expect(computeWaveformPeaks(Float32Array.from([Number.NaN, Number.NaN]), 1)).toEqual([
      { min: 0, max: 0 },
    ]);
  });

  it("rejects a non-positive or fractional bucket count", () => {
    expect(() => computeWaveformPeaks(new Float32Array(4), 0)).toThrow(MediaError);
    expect(() => computeWaveformPeaks(new Float32Array(4), -1)).toThrow(MediaError);
    expect(() => computeWaveformPeaks(new Float32Array(4), 1.5)).toThrow(MediaError);
  });
});

describe("pcmF32ToSamples", () => {
  it("round-trips little-endian float32 PCM", () => {
    const source = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    const decoded = pcmF32ToSamples(bytes);
    expect(Array.from(decoded)).toEqual(Array.from(source));
  });

  it("decodes from an unaligned slice by copying", () => {
    const source = Float32Array.from([0.25, -0.75]);
    const pool = Buffer.alloc(source.byteLength + 3);
    const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    bytes.copy(pool, 3);
    const decoded = pcmF32ToSamples(pool.subarray(3));
    expect(Array.from(decoded)).toEqual([0.25, -0.75]);
  });

  it("ignores a trailing partial sample", () => {
    const source = Float32Array.from([0.5, 0.25]);
    const bytes = Buffer.concat([
      Buffer.from(source.buffer, source.byteOffset, source.byteLength),
      Buffer.from([1, 2]),
    ]);
    const decoded = pcmF32ToSamples(bytes);
    expect(decoded).toHaveLength(2);
    expect(Array.from(decoded)).toEqual([0.5, 0.25]);
  });
});

describe("waveformPeaksToInterleaved", () => {
  it("flattens peaks into [min, max] pairs", () => {
    expect(
      waveformPeaksToInterleaved({
        buckets: 2,
        peaks: [
          { min: -1, max: 0.5 },
          { min: -0.25, max: 0.25 },
        ],
      }),
    ).toEqual([
      [-1, 0.5],
      [-0.25, 0.25],
    ]);
  });
});
