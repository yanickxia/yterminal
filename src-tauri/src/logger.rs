//! Lightweight, dependency-free debug logging for yterminal.
//!
//! Why this exists: the app intermittently "hangs and won't accept input"
//! while everything else looks fine. The prime suspect is the PTY data plane —
//! `pty_read` is an async command that performs a *blocking* `reader.read()`,
//! which can starve Tauri's async runtime so that `pty_write` (your keystrokes)
//! never gets scheduled. To diagnose that we need a log that survives even when
//! the async runtime is wedged.
//!
//! Design choices that matter:
//!   * Every command here is a **synchronous** `#[tauri::command]`. Tauri runs
//!     sync commands on a dedicated thread pool, independent of the tokio async
//!     runtime, so logging + export keep working even if every async PTY task
//!     is blocked. This is the whole point.
//!   * State lives behind a `std::sync::Mutex` (not the async `Mutex`), for the
//!     same reason — no `.await`, no runtime dependency.
//!   * We keep an in-memory ring buffer (recent entries, cheap to dump) AND
//!     append every entry to an on-disk file (full history across the session),
//!     so an export captures both the live tail and the long backstory.
//!   * The frontend funnels its own log entries here via `log_event`, so a
//!     single export merges the Rust and JS timelines in chronological order.
//!   * We never log terminal *content* (could contain secrets) — only sizes,
//!     pids, durations, and control metadata.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// How many recent lines to keep in the in-memory ring. The on-disk file keeps
/// the full history; this is just for a fast, allocation-bounded tail dump.
const RING_CAPACITY: usize = 20_000;

/// Truncate the on-disk log at startup if it has grown beyond this, so a
/// long-lived install doesn't accumulate an unbounded file.
const MAX_LOG_BYTES: u64 = 16 * 1024 * 1024;

/// `verbose` gates DEBUG/TRACE-level entries. Default ON: the bug we're chasing
/// is rare, so we want maximum detail captured by default until the user opts
/// out. Stored as an atomic so the hot logging path can check it without taking
/// the mutex.
static VERBOSE: AtomicBool = AtomicBool::new(true);

struct LogState {
    ring: VecDeque<String>,
    file: Option<File>,
}

static STATE: OnceLock<Mutex<LogState>> = OnceLock::new();

/// Directory that holds the log + exports.
///   macOS / Linux: $XDG_DATA_HOME/yterminal/logs  (or ~/.local/share/...)
///   Windows:       %APPDATA%\yterminal\logs
fn log_dir() -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share"))
        })
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("yterminal").join("logs")
}

fn active_log_path() -> PathBuf {
    log_dir().join("yterminal.log")
}

fn state() -> &'static Mutex<LogState> {
    STATE.get_or_init(|| {
        let dir = log_dir();
        let _ = std::fs::create_dir_all(&dir);
        let path = active_log_path();
        // start a fresh-ish file if the old one got huge
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > MAX_LOG_BYTES {
                let _ = std::fs::remove_file(&path);
            }
        }
        let file = OpenOptions::new().create(true).append(true).open(&path).ok();
        Mutex::new(LogState {
            ring: VecDeque::with_capacity(RING_CAPACITY),
            file,
        })
    })
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Format epoch-millis as an ISO-8601 UTC timestamp with millisecond precision,
/// e.g. `2026-06-29T15:25:31.123Z`. Pure arithmetic so we pull in no date crate.
fn fmt_utc(ms: u128) -> String {
    let secs = (ms / 1000) as i64;
    let milli = (ms % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, hour, min, sec, milli
    )
}

/// Howard Hinnant's days-from-civil, inverted: turn a count of days since the
/// Unix epoch into (year, month, day). Valid across the whole practical range.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m as u32, d)
}

/// Core entry point used by Rust callers. `level` is one of
/// ERROR / WARN / INFO / DEBUG / TRACE; `source` is a short subsystem tag
/// (e.g. "pty", "main"). DEBUG/TRACE are dropped unless verbose is on.
pub fn log(level: &str, source: &str, message: &str) {
    let lvl = level.to_ascii_uppercase();
    let verbose = VERBOSE.load(Ordering::Relaxed);
    if !verbose && (lvl == "DEBUG" || lvl == "TRACE") {
        return;
    }
    let line = format!("{} [{}] [{}] {}", fmt_utc(now_millis()), lvl, source, message);
    if let Ok(mut st) = state().lock() {
        if st.ring.len() >= RING_CAPACITY {
            st.ring.pop_front();
        }
        st.ring.push_back(line.clone());
        if let Some(f) = st.file.as_mut() {
            let _ = writeln!(f, "{}", line);
            let _ = f.flush();
        }
    }
    // Mirror to stderr so `tauri dev` consoles see it too; harmless in release.
    eprintln!("{}", line);
}

/// Convenience wrappers for Rust call sites.
pub fn info(source: &str, message: &str) {
    log("INFO", source, message);
}
pub fn warn(source: &str, message: &str) {
    log("WARN", source, message);
}
pub fn error(source: &str, message: &str) {
    log("ERROR", source, message);
}
pub fn debug(source: &str, message: &str) {
    log("DEBUG", source, message);
}
// ============================================================================
// Tauri commands (all synchronous on purpose — see module docs).
// ============================================================================

/// Push a single log entry originating in the frontend. The frontend stamps its
/// own ISO timestamp into `message`-adjacent fields, but we re-stamp on arrival
/// so ordering stays consistent with Rust-side entries.
#[tauri::command]
pub fn log_event(level: String, source: String, message: String) {
    log(&level, &source, &message);
}

/// Toggle verbose (DEBUG/TRACE) capture at runtime, from the Settings panel.
#[tauri::command]
pub fn set_log_verbose(verbose: bool) {
    VERBOSE.store(verbose, Ordering::Relaxed);
    log("INFO", "logger", &format!("verbose logging set to {verbose}"));
}

/// Read the current verbose flag (so the UI can reflect the real backend state).
#[tauri::command]
pub fn get_log_verbose() -> bool {
    VERBOSE.load(Ordering::Relaxed)
}

/// Absolute path of the directory holding the log + exports (for the UI).
#[tauri::command]
pub fn log_dir_path() -> String {
    log_dir().to_string_lossy().to_string()
}

/// Wipe the in-memory ring and the on-disk log file. Returns nothing useful;
/// best-effort.
#[tauri::command]
pub fn clear_logs() -> Result<(), String> {
    if let Ok(mut st) = state().lock() {
        st.ring.clear();
        // reopen the file truncated
        let path = active_log_path();
        let _ = std::fs::remove_file(&path);
        st.file = OpenOptions::new().create(true).append(true).open(&path).ok();
    }
    log("INFO", "logger", "logs cleared");
    Ok(())
}

/// Write a timestamped snapshot of the full on-disk log to an `export-*.log`
/// file in the log directory and return its absolute path. Falls back to the
/// in-memory ring if the on-disk file can't be read. This is the command the
/// "Export logs" button calls.
#[tauri::command]
pub fn export_logs() -> Result<String, String> {
    log("INFO", "logger", "export requested");
    let dir = log_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    // Prefer the on-disk file (full history). Flush the current handle first so
    // the freshest lines are included.
    let body: String = {
        if let Ok(mut st) = state().lock() {
            if let Some(f) = st.file.as_mut() {
                let _ = f.flush();
            }
        }
        match std::fs::read_to_string(active_log_path()) {
            Ok(s) if !s.trim().is_empty() => s,
            _ => {
                // fall back to whatever is in the ring
                state()
                    .lock()
                    .map(|st| st.ring.iter().cloned().collect::<Vec<_>>().join("\n"))
                    .unwrap_or_default()
            }
        }
    };

    let stamp = fmt_utc(now_millis()).replace([':'], "-").replace('.', "-");
    let out = dir.join(format!("export-{stamp}.log"));
    let header = format!(
        "# yterminal debug log export\n# generated: {}\n# verbose: {}\n# note: terminal contents are NOT logged; only metadata, sizes, pids, and timings.\n\n",
        fmt_utc(now_millis()),
        VERBOSE.load(Ordering::Relaxed)
    );
    std::fs::write(&out, format!("{header}{body}"))
        .map_err(|e| format!("write {}: {e}", out.display()))?;
    let path = out.to_string_lossy().to_string();
    log("INFO", "logger", &format!("export written to {path}"));
    Ok(path)
}
