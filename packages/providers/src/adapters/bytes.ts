/**
 * Deterministic byte encoders used by `MockAdapter`.
 *
 * The headless e2e driver commits these bytes as a project asset, so they are not
 * decoration: the PNG is a legally-encoded 8-bit RGBA image (IHDR/IDAT/IEND with correct
 * CRC-32s), and the WAV is a canonical 44-byte header plus PCM silence.
 */
import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// CRC-32 (PNG) / Adler-32 (zlib streaming checksum)
// ---------------------------------------------------------------------------

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** PNG CRC-32 (IEEE 802.3, reflected). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    const index = (crc ^ bytes[i]!) & 0xff;
    crc = (CRC_TABLE[index]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** zlib Adler-32, exported for callers that hand-build IDAT streams. */
export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]!) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(4 + 4 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

export interface PngOptions {
  readonly width?: number;
  readonly height?: number;
  /** Deterministic RGB base colour. */
  readonly rgb?: readonly [number, number, number];
  /** Adds a per-row luminance gradient so two seeds produce different bytes. */
  readonly gradient?: number;
}

/**
 * Build a valid 8-bit RGBA PNG.
 *
 * Uses a stored (uncompressed) zlib stream so no compressor is involved: the bytes are
 * identical on every platform and every run, which is what "deterministic" has to mean
 * for a hash-based e2e assertion.
 */
export function encodePng(options: PngOptions = {}): Uint8Array {
  const width = Math.max(1, Math.trunc(options.width ?? 64));
  const height = Math.max(1, Math.trunc(options.height ?? 64));
  const [r, g, b] = options.rgb ?? [32, 96, 192];
  const gradient = options.gradient ?? 0;

  const bytesPerRow = width * 4;
  const raw = new Uint8Array((bytesPerRow + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (bytesPerRow + 1);
    raw[rowStart] = 0; // filter type 0 (None)
    for (let x = 0; x < width; x += 1) {
      const px = rowStart + 1 + x * 4;
      const shade = (x + y + gradient) % 32;
      raw[px] = clampByte(r + shade);
      raw[px + 1] = clampByte(g + shade);
      raw[px + 2] = clampByte(b + shade);
      raw[px + 3] = 255;
    }
  }

  const zlib = deflateSync(raw, { level: 0 });
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(zlib)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** True when `bytes` carries the PNG signature (used by tests and the media layer). */
export function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((byte, index) => bytes[index] === byte);
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

export interface WavOptions {
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly bitsPerSample?: number;
  readonly durationSeconds?: number;
  /** When true (default) the PCM payload is digital silence. */
  readonly silent?: boolean;
  readonly seed?: number;
}

export interface WavEncoding {
  readonly bytes: Uint8Array;
  /** Always 44 for the canonical RIFF/WAVE layout produced here. */
  readonly headerBytes: number;
  readonly dataBytes: number;
  readonly durationSeconds: number;
  readonly mimeType: "audio/wav";
}

/**
 * Canonical RIFF/WAVE PCM: `RIFF` + `fmt ` (16 bytes) + `data`, which is exactly a
 * 44-byte header followed by interleaved samples.
 */
export function encodeWav(options: WavOptions = {}): WavEncoding {
  const sampleRate = Math.max(1, Math.trunc(options.sampleRate ?? 44_100));
  const channels = Math.max(1, Math.trunc(options.channels ?? 1));
  const bitsPerSample = options.bitsPerSample ?? 16;
  const durationSeconds = options.durationSeconds ?? 1;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataBytes = frameCount * channels * bytesPerSample;
  const silent = options.silent ?? true;

  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
  view.setUint16(32, channels * bytesPerSample, true); // block align
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  if (!silent) {
    // A quiet deterministic tone, again platform independent.
    const frequency = 220 + ((options.seed ?? 0) % 8) * 55;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const value = Math.round(
        0.05 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate) * 32767,
      );
      for (let channel = 0; channel < channels; channel += 1) {
        const offset = 44 + (frame * channels + channel) * bytesPerSample;
        if (bytesPerSample === 2) view.setInt16(offset, value, true);
        else view.setUint8(offset, 128 + (value >> 8));
      }
    }
  }

  return {
    bytes: new Uint8Array(buffer),
    headerBytes: 44,
    dataBytes,
    durationSeconds: frameCount / sampleRate,
    mimeType: "audio/wav",
  };
}

/** True when `bytes` carries a RIFF/WAVE header. */
export function isWav(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const head = String.fromCharCode(...bytes.slice(0, 4));
  const form = String.fromCharCode(...bytes.slice(8, 12));
  return head === "RIFF" && form === "WAVE";
}

// ---------------------------------------------------------------------------
// Video stand-in
// ---------------------------------------------------------------------------

/**
 * A tiny ISO-BMFF `ftyp` box.
 *
 * Deliberately *not* presented as a playable video: the header is valid enough for the
 * media layer's container sniffing, and the payload is a deterministic byte blob. The
 * mock reports `video/mp4` so the e2e driver exercises the same "probe before trust" path
 * a real provider output takes.
 */
export function encodeVideoBlob(seed = 0, size = 4_096): Uint8Array {
  const out = new Uint8Array(Math.max(24, size));
  const view = new DataView(out.buffer);
  view.setUint32(0, 24); // box size
  writeAscii(view, 4, "ftyp");
  writeAscii(view, 8, "isom");
  view.setUint32(12, 0x200);
  writeAscii(view, 16, "isomiso2");
  for (let i = 24; i < out.length; i += 1) out[i] = (i * 31 + seed * 17) & 0xff;
  return out;
}

/** Deterministic UTF-8 payload for transcription-style outputs. */
export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i) & 0xff);
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.trunc(value)));
}
