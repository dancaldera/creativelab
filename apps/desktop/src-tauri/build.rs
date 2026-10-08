//! Tauri build script.
//!
//! Two things happen here:
//!  1. `tauri_build::build()` generates the permission/capability glue from
//!     `tauri.conf.json` and `capabilities/default.json`.
//!  2. An app icon is generated into `icons/icon.png` if it is missing.
//!
//! Point 2 exists because `tauri.conf.json` intentionally lists no `bundle.icon` entries —
//! there is no binary art in this repository — yet `tauri::generate_context!` still needs
//! `icons/icon.png` on disk at compile time. Generating it keeps the tree text-only, and the
//! `is_file` guard means a real icon dropped in later is never overwritten.
//!
//! Schema migrations are *not* copied or transformed here: `src/db/migrate.rs` embeds the
//! canonical `packages/core/migrations/0001_init.sql` with `include_str!` so that the Rust
//! store and the TypeScript store provably hash the same bytes.

use std::io::Write;
use std::path::Path;

#[path = "build_tools/generate_icon.rs"]
mod generate_icon;

fn main() {
    ensure_icon();
    tauri_build::build()
}

fn ensure_icon() {
    let icons = Path::new(env!("CARGO_MANIFEST_DIR")).join("icons");
    if let Err(error) = std::fs::create_dir_all(&icons) {
        println!("cargo:warning=could not create the icons directory: {error}");
        return;
    }
    let path = icons.join("icon.png");
    println!("cargo:rerun-if-changed={}", path.display());
    if path.is_file() {
        return;
    }
    match generate_icon::render_png_bytes() {
        Ok(bytes) => match std::fs::write(&path, bytes) {
            Ok(()) => println!("cargo:warning=generated {}", path.display()),
            Err(error) => println!("cargo:warning=could not write {}: {error}", path.display()),
        },
        Err(error) => println!("cargo:warning=could not render the icon: {error}"),
    }
}

/// Keeps `Write` in scope for the `#[path]`-included module's `write_all` calls.
#[allow(dead_code)]
fn _assert_write_is_used(writer: &mut impl Write) -> std::io::Result<()> {
    writer.flush()
}
