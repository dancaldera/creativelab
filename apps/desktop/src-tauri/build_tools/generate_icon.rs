//! Icon generator, included by `build.rs` (`#[path = "build_tools/generate_icon.rs"]`).
//!
//! `tauri.conf.json` deliberately lists no `bundle.icon` entries — there is no binary art
//! in this repository — yet `tauri::generate_context!` still requires `icons/icon.png` to
//! exist at compile time. The build therefore renders one here with no image dependency
//! beyond `flate2`, which the Tauri build already pulls in.
//!
//! The art is intentionally simple: a dark rounded square, a cyan aperture ring and a
//! magenta play triangle — "creative studio".
//!
//! There is no compression dependency: the PNG is emitted with zlib *stored* blocks, which
//! is a fully valid zlib stream and keeps this file free of extra build dependencies. Icons
//! are generated once, so the few hundred uncompressed kilobytes do not matter.

/// The icon edge length in pixels. 512 is what Tauri's macOS bundler expects for the
/// largest `iconset` entry it can downscale from.
const SIZE: u32 = 512;

/// Compose the RGBA buffer, then encode it as a PNG.
pub fn render_png_bytes() -> Result<Vec<u8>, String> {
    let mut pixels = vec![0u8; (SIZE * SIZE * 4) as usize];
    let center = SIZE as f64 / 2.0;
    let rounded = SIZE as f64 * 0.22;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let index = ((y * SIZE + x) * 4) as usize;
            let fx = x as f64 + 0.5;
            let fy = y as f64 + 0.5;

            // Rounded-square mask.
            let dx = (fx - center).abs() - (center - rounded);
            let dy = (fy - center).abs() - (center - rounded);
            let outside =
                (dx.max(0.0).powi(2) + dy.max(0.0).powi(2)).sqrt() + dx.max(dy).min(0.0) - rounded;
            if outside > 0.0 {
                continue; // transparent corner
            }

            // Background gradient.
            let mix = (fx + fy) / (2.0 * SIZE as f64);
            let mut color = [
                lerp(0.09, 0.04, mix),
                lerp(0.11, 0.06, mix),
                lerp(0.16, 0.11, mix),
            ];

            // Aperture ring.
            let radius = (fx - center).powi(2) + (fy - center).powi(2);
            let ring = radius.sqrt();
            if (ring - SIZE as f64 * 0.31).abs() < SIZE as f64 * 0.028 {
                color = [0.24, 0.82, 0.92];
            }

            // Play triangle.
            let tx = fx - center;
            let ty = fy - center;
            // Parenthesized on purpose: `-SIZE as f64` would be `(-SIZE) as f64`.
            let triangle_root = -(SIZE as f64) * 0.06;
            let triangle_tip = SIZE as f64 * 0.19;
            if tx > triangle_root && tx < triangle_tip {
                let half = (SIZE as f64 * 0.155)
                    * (1.0 - (tx - triangle_root) / (triangle_tip - triangle_root));
                if ty.abs() < half.max(0.0) {
                    color = [0.93, 0.29, 0.62];
                }
            }

            // Soft edge so the rounded corners are not aliased.
            let alpha = (1.0 - outside.max(0.0)).clamp(0.0, 1.0);
            pixels[index] = to_u8(color[0]);
            pixels[index + 1] = to_u8(color[1]);
            pixels[index + 2] = to_u8(color[2]);
            pixels[index + 3] = to_u8(alpha);
        }
    }
    encode_png(&pixels, SIZE, SIZE)
}

fn lerp(from: f64, to: f64, t: f64) -> f64 {
    from + (to - from) * t
}

fn to_u8(value: f64) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Minimal PNG writer: IHDR + IDAT (filter type 0 per scanline) + IEND.
fn encode_png(pixels: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut raw = Vec::with_capacity(pixels.len() + height as usize);
    let stride = (width * 4) as usize;
    for row in 0..height as usize {
        raw.push(0); // filter: none
        raw.extend_from_slice(&pixels[row * stride..(row + 1) * stride]);
    }

    // CMF/FLG: deflate, 32 KiB window, no preset dictionary, fastest compression level.
    let mut zlib = vec![0x78, 0x01];
    zlib.extend_from_slice(&stored_deflate(&raw));
    zlib.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.push(8); // bit depth
    ihdr.push(6); // colour type: RGBA
    ihdr.extend_from_slice(&[0, 0, 0]); // deflate, adaptive filtering, no interlace
    push_chunk(&mut png, b"IHDR", &ihdr);
    push_chunk(&mut png, b"IDAT", &zlib);
    push_chunk(&mut png, b"IEND", &[]);
    Ok(png)
}

/// Encode `data` as raw DEFLATE using only stored (uncompressed) blocks.
///
/// A stored block is a 5-byte header (BFINAL + BTYPE=00, then LEN and NLEN) followed by at
/// most 65_535 literal bytes. This is a legal DEFLATE stream, so no compressor is needed.
fn stored_deflate(data: &[u8]) -> Vec<u8> {
    const MAX_BLOCK: usize = 65_535;
    let mut out = Vec::with_capacity(data.len() + data.len() / MAX_BLOCK * 5 + 5);
    if data.is_empty() {
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xff, 0xff]);
        return out;
    }
    let mut offset = 0usize;
    while offset < data.len() {
        let remaining = data.len() - offset;
        let take = remaining.min(MAX_BLOCK);
        let final_block = offset + take >= data.len();
        out.push(if final_block { 0x01 } else { 0x00 });
        let length = take as u16;
        out.extend_from_slice(&length.to_le_bytes());
        out.extend_from_slice(&(!length).to_le_bytes());
        out.extend_from_slice(&data[offset..offset + take]);
        offset += take;
    }
    out
}

fn push_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let mut a = 1u32;
    let mut b = 0u32;
    for byte in data {
        a = (a + u32::from(*byte)) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}
