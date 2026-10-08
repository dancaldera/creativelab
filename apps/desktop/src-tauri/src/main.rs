//! Binary entry point.
//!
//! Everything lives in the library (`creativelab_desktop_lib::run`) so the same code can be
//! exercised by `cargo test` without launching a window. `windows_subsystem` keeps the
//! release build from opening a console on Windows, where the crate would otherwise emit
//! one for the `staticlib`/`cdylib` targets.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    creativelab_desktop_lib::run()
}
