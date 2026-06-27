// yterminal Tauri backend.
// The heavy lifting (PTY spawn/IO) is provided by tauri-plugin-pty, which the
// frontend talks to via the `tauri-pty` JS package. We just register plugins.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_pty::init())
        .run(tauri::generate_context!())
        .expect("error while running yterminal");
}
