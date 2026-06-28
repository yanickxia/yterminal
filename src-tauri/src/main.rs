// yterminal Tauri backend.
// The heavy lifting (PTY spawn/IO) is provided by tauri-plugin-pty, which the
// frontend talks to via the `tauri-pty` JS package. We just register plugins.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

/// Return the user's preferred login shell.
///
/// On Unix this honors the `$SHELL` environment variable (what the user's
/// account is actually configured to use — zsh on modern macOS), falling back
/// to `/bin/zsh` then `/bin/bash`. On Windows it returns PowerShell. Spawning
/// the *real* login shell avoids loading zsh-only rc files under bash.
#[tauri::command]
fn default_shell() -> String {
    #[cfg(windows)]
    {
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        if let Ok(sh) = std::env::var("SHELL") {
            if !sh.trim().is_empty() {
                return sh;
            }
        }
        for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
            if std::path::Path::new(candidate).exists() {
                return candidate.to_string();
            }
        }
        "/bin/sh".to_string()
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_pty::init())
        .invoke_handler(tauri::generate_handler![default_shell])
        .run(tauri::generate_context!())
        .expect("error while running yterminal");
}
