// yterminal Tauri backend.
// The heavy lifting (PTY spawn/IO) is provided by tauri-plugin-pty, which the
// frontend talks to via the `tauri-pty` JS package. We just register plugins.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

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

/// Absolute path to the JSON config file: `~/.config/yterminal/config.json`
/// (or `%APPDATA%\yterminal\config.json` on Windows). This is a plain,
/// user-editable file so it can be version-controlled / synced across machines.
fn config_path() -> std::path::PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    base.join("yterminal").join("config.json")
}

/// Return the config file path as a string (so the UI can show it).
#[tauri::command]
fn config_file_path() -> String {
    config_path().to_string_lossy().to_string()
}

/// Read the JSON config file. Returns its raw contents, or an empty string if
/// the file does not exist yet (the frontend then uses its defaults).
#[tauri::command]
fn read_config() -> Result<String, String> {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("failed to read {}: {e}", path.display())),
    }
}

/// Write the JSON config file, creating the parent directory if needed.
#[tauri::command]
fn write_config(contents: String) -> Result<(), String> {
    let path = config_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, contents)
        .map_err(|e| format!("failed to write {}: {e}", path.display()))
}

/// Enumerate the monospace font families installed on this machine.
///
/// The WebViews Tauri uses (WKWebView on macOS, WebKitGTK on Linux) don't
/// implement the Local Font Access API, so the frontend can't list installed
/// fonts itself. font-kit reads the platform's native font catalog. We load one
/// representative face per family and keep only the monospaced ones (a terminal
/// only wants fixed-width fonts), returning a sorted, de-duplicated list.
fn enumerate_fonts() -> Vec<String> {
    use font_kit::loader::Loader; // brings is_monospace() into scope
    use font_kit::source::SystemSource;

    let source = SystemSource::new();
    let families = match source.all_families() {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };

    let mut mono: Vec<String> = Vec::new();
    for family in families {
        // load a handle for this family; skip families we can't resolve/parse
        let handle = match source.select_family_by_name(&family) {
            Ok(h) => h,
            Err(_) => continue,
        };
        let fonts = handle.fonts();
        let Some(first) = fonts.first() else { continue };
        if let Ok(font) = first.load() {
            if font.is_monospace() {
                mono.push(family);
            }
        }
    }

    mono.sort_by_key(|s| s.to_lowercase());
    mono.dedup();
    mono
}

/// Path of the JSON cache for the monospace font list. Lives next to the main
/// config file so it gets cleaned up with the rest of yterminal's state.
fn fonts_cache_path() -> std::path::PathBuf {
    config_path()
        .parent()
        .map(|d| d.join("fonts-cache.json"))
        .unwrap_or_else(|| std::path::PathBuf::from("fonts-cache.json"))
}

fn read_fonts_cache() -> Option<Vec<String>> {
    let text = std::fs::read_to_string(fonts_cache_path()).ok()?;
    let list: Vec<String> = serde_json::from_str(&text).ok()?;
    if list.is_empty() {
        None
    } else {
        Some(list)
    }
}

fn write_fonts_cache(list: &[String]) {
    let path = fonts_cache_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(list) {
        let _ = std::fs::write(path, json);
    }
}

/// Return the cached font list if present (cheap), else enumerate, cache, and
/// return. Enumeration walks the OS font catalog and parses one face per family
/// — on macOS with hundreds of installed families that can take 1-2 seconds, so
/// caching to disk makes second-and-later launches effectively free.
#[tauri::command]
fn list_fonts() -> Vec<String> {
    if let Some(cached) = read_fonts_cache() {
        return cached;
    }
    let list = enumerate_fonts();
    write_fonts_cache(&list);
    list
}

/// Force a fresh enumeration and rewrite the cache. Useful after the user
/// installs new fonts; called from the Settings panel.
#[tauri::command]
fn refresh_fonts() -> Vec<String> {
    let list = enumerate_fonts();
    write_fonts_cache(&list);
    list
}

/// Resolve the current working directory of a running process.
///
/// Used by the frontend so a new tab can inherit the *actual* cwd of the
/// active shell (not just the cwd it was spawned in), and so a restarted
/// session can reopen in the directory where the user left off.
///
/// macOS: shell out to `lsof -a -p PID -d cwd -F n`. `-F n` formats output as
///   `pPID\nfcwd\nn<path>` — we grab the `n`-prefixed line. `lsof` is
///   universally present on macOS and avoids a libproc/unsafe dependency.
/// Linux: read the symlink at `/proc/<pid>/cwd` — a single syscall.
/// Windows: not supported (no equivalent without OpenProcess + NtQuery).
#[tauri::command]
fn process_cwd(pid: u32) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/sbin/lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-F", "n"])
            .output()
            .map_err(|e| format!("spawn lsof: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "lsof exit {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some(rest) = line.strip_prefix('n') {
                let s = rest.trim();
                if !s.is_empty() {
                    return Ok(s.to_string());
                }
            }
        }
        Err("no cwd in lsof output".into())
    }
    #[cfg(target_os = "linux")]
    {
        let path = format!("/proc/{}/cwd", pid);
        std::fs::read_link(&path)
            .map(|p| p.to_string_lossy().to_string())
            .map_err(|e| format!("read_link {path}: {e}"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        Err("process_cwd not supported on this platform".into())
    }
}

// ============================================================================
// Per-pane scrollback storage (SQLite).
//
// Each pane's serialized xterm buffer lives in a single SQLite database. The
// frontend invokes `scrollback_save` on the same 15s autosave tick it used to
// run against localStorage, but now without the ~5MB origin quota or sync
// blocking. `scrollback_clear` is wired into pane disposal so dead panes don't
// linger on disk; `scrollback_prune` is the startup GC for orphans.
// ============================================================================

/// Absolute path to the scrollback DB file.
///   macOS / Linux: $XDG_DATA_HOME/yterminal/scrollback.db
///                  (or ~/.local/share/yterminal/scrollback.db)
///   Windows:       %APPDATA%\yterminal\scrollback.db
fn scrollback_db_path() -> std::path::PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|h| std::path::PathBuf::from(h).join(".local").join("share"))
        })
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    base.join("yterminal").join("scrollback.db")
}

/// Process-wide single connection, lazily opened on first command. Guarded by
/// a `Mutex` because rusqlite's `Connection` isn't `Sync` — the commands here
/// are short-lived so contention is negligible.
static DB: OnceLock<Mutex<rusqlite::Connection>> = OnceLock::new();

fn db() -> Result<&'static Mutex<rusqlite::Connection>, String> {
    if let Some(d) = DB.get() {
        return Ok(d);
    }
    let path = scrollback_db_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    let conn = rusqlite::Connection::open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    // WAL mode lets readers and writers proceed without blocking each other,
    // important if we later run background reads on the UI thread.
    let _: Result<String, _> = conn.pragma_update_and_check(
        None,
        "journal_mode",
        &"WAL",
        |row| row.get::<_, String>(0),
    );
    conn.execute(
        "CREATE TABLE IF NOT EXISTS scrollback (
            pane_id    TEXT PRIMARY KEY,
            updated_at INTEGER NOT NULL,
            data       TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| format!("create table: {e}"))?;
    let _ = DB.set(Mutex::new(conn));
    Ok(DB.get().unwrap())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tauri::command]
fn scrollback_save(pane_id: String, data: String) -> Result<(), String> {
    let db = db()?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO scrollback (pane_id, updated_at, data) VALUES (?1, ?2, ?3)",
        rusqlite::params![pane_id, now_secs(), data],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Bulk-fetch every pane's snapshot in one trip. The frontend calls this once
/// at startup so subsequent `loadScrollback(paneId)` reads can stay synchronous
/// (the React lifecycle that consumes them isn't async-friendly).
#[tauri::command]
fn scrollback_load_all() -> Result<HashMap<String, String>, String> {
    let db = db()?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT pane_id, data FROM scrollback")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for r in rows {
        let (k, v) = r.map_err(|e| e.to_string())?;
        out.insert(k, v);
    }
    Ok(out)
}

#[tauri::command]
fn scrollback_clear(pane_id: String) -> Result<(), String> {
    let db = db()?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM scrollback WHERE pane_id = ?1",
        rusqlite::params![pane_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Startup GC: drop every snapshot whose pane id isn't in the live set.
/// Empty `live_pane_ids` wipes everything (treated as "no panes survived").
#[tauri::command]
fn scrollback_prune(live_pane_ids: Vec<String>) -> Result<(), String> {
    let db = db()?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    if live_pane_ids.is_empty() {
        conn.execute("DELETE FROM scrollback", [])
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let placeholders = std::iter::repeat("?")
        .take(live_pane_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "DELETE FROM scrollback WHERE pane_id NOT IN ({})",
        placeholders
    );
    let params: Vec<&dyn rusqlite::ToSql> = live_pane_ids
        .iter()
        .map(|s| s as &dyn rusqlite::ToSql)
        .collect();
    conn.execute(&sql, params.as_slice())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            default_shell,
            config_file_path,
            read_config,
            write_config,
            list_fonts,
            refresh_fonts,
            process_cwd,
            scrollback_save,
            scrollback_load_all,
            scrollback_clear,
            scrollback_prune
        ])
        .run(tauri::generate_context!())
        .expect("error while running yterminal");
}
