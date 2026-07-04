// yterminal Tauri backend.
// PTY (shell spawn / IO) lives in `pty.rs`. We invoke `portable-pty` directly
// instead of going through `tauri-plugin-pty`, which exposed an internal
// session counter as `pty.pid` and broke `process_cwd` lookups.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod logger;
mod pty;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::ipc::Channel;
use tauri::Manager;

#[tauri::command]
fn open_devtools(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
    }
}

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
/// session can reopen in the directory where the user left off. Our `pty_spawn`
/// returns the real OS child pid to the frontend, so this command always
/// receives a queryable pid (the upstream `tauri-plugin-pty` returned an
/// internal session counter and made this command effectively dead code).
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
// Agent session resume support.
//
// Two read-only introspection commands used by the frontend to (a) detect a
// coding agent (Claude Code / Codex / OpenCode) running inside a pane's shell
// and (b) resolve that agent's current on-disk session id, so a restored tab
// can respawn the agent with its resume flag. Both are SYNC commands (run on
// Tauri's sync command pool, like `process_cwd`) — they only read /proc, run
// `ps`, or stat files, so they never need the async runtime and can't starve
// the PTY data plane.
// ============================================================================

/// One process in a pane's descendant tree. `argv` is the full command line
/// (argv[0] first) so the frontend can match an agent even when it's launched
/// via a node wrapper or a shell alias that resolves to a different binary.
#[derive(serde::Serialize)]
struct ProcInfo {
    pid: u32,
    ppid: u32,
    argv: Vec<String>,
}

/// Return every descendant process of `pid` (not including `pid` itself) with
/// its argv. Used to detect a coding agent running inside a pane's shell.
///
/// Linux: walk `/proc`, reading `/proc/<pid>/stat` for ppid and
///   `/proc/<pid>/cmdline` (NUL-separated) for argv.
/// macOS: one `ps -axo pid=,ppid=,command=` pass, then filter to descendants.
/// Other: empty (feature inert, same as `process_cwd`).
#[tauri::command]
fn pane_process_tree(pid: u32) -> Vec<ProcInfo> {
    let all = enumerate_processes();
    descendants_of(pid, all)
}

/// Read every process on the machine as (pid, ppid, argv).
#[cfg(target_os = "linux")]
fn enumerate_processes() -> Vec<ProcInfo> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir("/proc") {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };
        let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(s) => s,
            Err(_) => continue,
        };
        // `comm` (field 2) is parenthesized and can contain spaces/parens, so
        // ppid (field 4) must be located relative to the LAST ')'.
        let Some(close) = stat.rfind(')') else {
            continue;
        };
        let rest: Vec<&str> = stat[close + 1..].split_whitespace().collect();
        // rest[0] = state, rest[1] = ppid
        let ppid = rest.get(1).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
        let argv = read_cmdline_linux(pid);
        out.push(ProcInfo { pid, ppid, argv });
    }
    out
}

#[cfg(target_os = "linux")]
fn read_cmdline_linux(pid: u32) -> Vec<String> {
    match std::fs::read(format!("/proc/{pid}/cmdline")) {
        Ok(bytes) => bytes
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(target_os = "macos")]
fn enumerate_processes() -> Vec<ProcInfo> {
    let out = match std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()
    {
        Ok(o) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };
    let mut procs = Vec::new();
    for line in String::from_utf8_lossy(&out).lines() {
        let line = line.trim_start();
        let mut it = line.splitn(3, char::is_whitespace);
        let (Some(pid_s), Some(ppid_s), Some(cmd)) = (it.next(), it.next(), it.next()) else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid_s.parse::<u32>(), ppid_s.parse::<u32>()) else {
            continue;
        };
        // `ps command=` is the full command line as a single string; split on
        // whitespace for a best-effort argv. Good enough for basename matching;
        // paths with spaces are rare for agent binaries.
        let argv = cmd.split_whitespace().map(|s| s.to_string()).collect();
        procs.push(ProcInfo { pid, ppid, argv });
    }
    procs
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn enumerate_processes() -> Vec<ProcInfo> {
    Vec::new()
}

/// Filter `all` to the transitive descendants of `root` (excluding `root`).
fn descendants_of(root: u32, all: Vec<ProcInfo>) -> Vec<ProcInfo> {
    use std::collections::{HashMap, HashSet, VecDeque};
    let mut children: HashMap<u32, Vec<usize>> = HashMap::new();
    for (i, p) in all.iter().enumerate() {
        children.entry(p.ppid).or_default().push(i);
    }
    let mut keep: HashSet<usize> = HashSet::new();
    let mut queue: VecDeque<u32> = VecDeque::new();
    queue.push_back(root);
    while let Some(parent) = queue.pop_front() {
        if let Some(idxs) = children.get(&parent) {
            for &i in idxs {
                if keep.insert(i) {
                    queue.push_back(all[i].pid);
                }
            }
        }
    }
    all.into_iter()
        .enumerate()
        .filter(|(i, _)| keep.contains(i))
        .map(|(_, p)| p)
        .collect()
}

/// Read environment variables for a single process. Used to recover env-var
/// configuration (e.g. ANTHROPIC_BASE_URL) the user's launcher alias set on
/// the agent, so we can replay it on resume even when we don't know the alias
/// name. Returned as a list of (key, value) pairs.
///
/// Linux: read `/proc/<pid>/environ` (NUL-separated KEY=VAL entries).
/// macOS: `ps eww -p <pid> -o command=` — env vars follow the argv,
///   space-separated as KEY=VAL tokens. Heuristic: a token whose substring
///   before the first `=` is a valid env-var name shape is treated as an env
///   entry. Values with spaces are mangled by this approach; for our caller's
///   whitelist (Anthropic / Claude / Codex / OpenCode keys) that's acceptable.
///   Caller filters by key whitelist anyway, so a stray argv look-alike is
///   harmless.
/// Other: empty.
#[tauri::command]
fn process_env(pid: u32) -> Vec<(String, String)> {
    #[cfg(target_os = "linux")]
    {
        let path = format!("/proc/{pid}/environ");
        match std::fs::read(&path) {
            Ok(bytes) => bytes
                .split(|b| *b == 0)
                .filter(|s| !s.is_empty())
                .filter_map(|s| {
                    let s = String::from_utf8_lossy(s).into_owned();
                    let eq = s.find('=')?;
                    Some((s[..eq].to_string(), s[eq + 1..].to_string()))
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    }
    #[cfg(target_os = "macos")]
    {
        let out = match std::process::Command::new("/bin/ps")
            .args(["eww", "-p", &pid.to_string(), "-o", "command="])
            .output()
        {
            Ok(o) if o.status.success() => o.stdout,
            _ => return Vec::new(),
        };
        let stdout = String::from_utf8_lossy(&out);
        let mut seen = std::collections::HashSet::new();
        let mut result: Vec<(String, String)> = Vec::new();
        for token in stdout.split_whitespace() {
            let Some(eq) = token.find('=') else { continue };
            if eq == 0 {
                continue;
            }
            let key = &token[..eq];
            let valid_key = key.chars().enumerate().all(|(i, c)| {
                if i == 0 {
                    c.is_ascii_uppercase() || c == '_'
                } else {
                    c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'
                }
            });
            if !valid_key {
                continue;
            }
            if seen.insert(key.to_string()) {
                result.push((key.to_string(), token[eq + 1..].to_string()));
            }
        }
        result
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        Vec::new()
    }
}

/// Resolve the current on-disk session id for `kind` ("claude" | "codex" |
/// "opencode"), bound to `cwd` where the agent needs it (Claude). Returns the
/// id string, or `None` if no session store is found.
#[tauri::command]
fn agent_session_id(kind: String, cwd: String) -> Option<String> {
    match kind.as_str() {
        "claude" => claude_session_id(&cwd),
        "codex" => codex_session_id(),
        "opencode" => opencode_session_id(&cwd),
        _ => None,
    }
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}

/// Newest-mtime file under `dir` (non-recursive) whose name passes `accept`.
fn newest_file_in<P: AsRef<std::path::Path>>(
    dir: P,
    accept: impl Fn(&str) -> bool,
) -> Option<std::path::PathBuf> {
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !accept(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
            best = Some((mtime, path));
        }
    }
    best.map(|(_, p)| p)
}

/// Recursively collect the newest-mtime file under `root` whose name passes
/// `accept`. Used for Codex (date-nested) and OpenCode (project-nested) stores.
fn newest_file_recursive(
    root: &std::path::Path,
    accept: &dyn Fn(&str) -> bool,
) -> Option<(std::time::SystemTime, std::path::PathBuf)> {
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                stack.push(path);
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !accept(&name) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(mtime) = meta.modified() else { continue };
            if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
                best = Some((mtime, path));
            }
        }
    }
    best
}

/// Map a cwd to Claude's escaped project-dir name: every run of non
/// `[A-Za-z0-9]` characters becomes a single `-`. e.g. `/home/me/app` →
/// `-home-me-app`.
fn claude_escape_cwd(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len());
    for ch in cwd.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    out
}

/// Claude: newest `*.jsonl` in `~/.claude/projects/<escaped-cwd>/`; the session
/// id is the file stem (a UUID). We trust the stem here — reading the last
/// JSONL line for the `sessionId` field is a future refinement.
fn claude_session_id(cwd: &str) -> Option<String> {
    let home = home_dir()?;
    let dir = home
        .join(".claude")
        .join("projects")
        .join(claude_escape_cwd(cwd));
    let newest = newest_file_in(&dir, |n| n.ends_with(".jsonl"))?;
    newest
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
}

/// Codex: newest `rollout-*.jsonl` under `$CODEX_HOME`/`~/.codex/sessions`; the
/// session id is the trailing UUID of the filename
/// (`rollout-<ISO-ts>-<uuid>.jsonl`).
fn codex_session_id() -> Option<String> {
    let base = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".codex")))?;
    let dir = base.join("sessions");
    let (_, path) =
        newest_file_recursive(&dir, &|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))?;
    let stem = path.file_stem()?.to_string_lossy().into_owned();
    // trailing 36-char UUID after the last "rollout-<timestamp>-" boundary.
    extract_trailing_uuid(&stem)
}

/// Pull a canonical 8-4-4-4-12 hex UUID off the end of `s`, if present.
fn extract_trailing_uuid(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    if bytes.len() < 36 {
        return None;
    }
    let tail = &s[s.len() - 36..];
    let ok = tail.chars().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => c == '-',
        _ => c.is_ascii_hexdigit(),
    });
    if ok {
        Some(tail.to_string())
    } else {
        None
    }
}

/// OpenCode: ids are `ses_<ULID>`, stored per-project under
/// `$OPENCODE_DATA_DIR`/`~/.local/share/opencode`. We scan for the newest file
/// whose stem starts with `ses_` and return that stem. cwd is currently unused
/// (the whole store is scanned) but kept in the signature for a future
/// project-slug-scoped lookup.
fn opencode_session_id(_cwd: &str) -> Option<String> {
    let base = std::env::var_os("OPENCODE_DATA_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".local").join("share").join("opencode")))?;
    let (_, path) = newest_file_recursive(&base, &|n| n.starts_with("ses_"))?;
    let stem = path.file_stem()?.to_string_lossy().into_owned();
    if stem.starts_with("ses_") {
        Some(stem)
    } else {
        None
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

// ============================================================================
// Read-only file viewing.
//
// Backs the in-app file viewer: a user Cmd/Ctrl-clicks a file path printed in
// the terminal, and we read it here so the WebView can render it (Markdown /
// syntax-highlighted text) without shelling out to an external editor. Reads
// are capped and binary-sniffed so a stray click on a huge log or a binary
// never freezes the UI or floods the IPC channel.
// ============================================================================

/// Largest file we'll load into the in-app viewer. Beyond this the frontend
/// falls back to opening the file with the OS default app.
const MAX_VIEWER_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB

/// Result of a viewer read: the decoded text plus the byte length we read.
#[derive(serde::Serialize)]
struct FileContents {
    text: String,
    bytes: u64,
}

/// True when `path` exists and is a regular file (not a dir / symlink-to-dir).
#[tauri::command]
fn path_is_file(path: String) -> bool {
    std::fs::metadata(&path)
        .map(|m| m.is_file())
        .unwrap_or(false)
}

/// Read a text file for the in-app viewer. Errors (rather than returning
/// partial/garbage) when the file is missing, too large, or looks binary, so
/// the caller can cleanly fall back to an external open.
#[tauri::command]
fn read_text_file(path: String) -> Result<FileContents, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a regular file"));
    }
    let len = meta.len();
    if len > MAX_VIEWER_BYTES {
        return Err(format!(
            "file too large for viewer ({} bytes > {} limit)",
            len, MAX_VIEWER_BYTES
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    // Binary sniff: a NUL byte in the first chunk is the classic heuristic
    // (used by git) for "this isn't text". Cheap and good enough to keep the
    // viewer text-only.
    let sniff = &bytes[..bytes.len().min(8000)];
    if sniff.contains(&0) {
        return Err(format!("{path} appears to be binary"));
    }
    // Decode lossily so a file with a few stray non-UTF8 bytes still opens
    // (replaced with U+FFFD) rather than failing outright.
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(FileContents {
        text,
        bytes: bytes.len() as u64,
    })
}

// ============================================================================
// Git sidebar — repo status for the active tab's cwd
// ============================================================================
// The git sidebar shows, for whatever directory the focused pane is sitting in,
// the current branch and the set of changed files (staged + unstaged +
// untracked) with per-file line deltas — the same "Changes" view an IDE gives
// you. We shell out to `git` (rather than linking libgit2) to exactly match the
// user's installed git behaviour, ignore rules, and worktree/submodule quirks,
// and because it's a cheap read that runs off the sync command pool.

/// One changed file in the working tree. `status` is the two-char porcelain XY
/// code (e.g. " M", "A ", "??", "R ") so the frontend can label/icon it;
/// `insertions`/`deletions` are the summed staged+unstaged line deltas (0 when
/// git can't diff it, e.g. binary or untracked-without-count).
#[derive(serde::Serialize)]
struct GitFile {
    path: String,
    status: String,
    insertions: u32,
    deletions: u32,
}

/// Result of inspecting a directory. When `is_repo` is false the other fields
/// are empty and the frontend hides the sidebar content.
#[derive(serde::Serialize)]
struct GitStatus {
    is_repo: bool,
    branch: String,
    root: String,
    files: Vec<GitFile>,
}

/// Resolve the `git` executable to an absolute path.
///
/// A macOS app launched from Finder/Dock inherits launchd's minimal `PATH`
/// (no `/opt/homebrew/bin`, no `/usr/local/bin`), so a bare `git` spawn fails
/// even though the same command works in a login-shell terminal. Mirror the
/// absolute-path pattern already used for `/usr/sbin/lsof` in `process_cwd`:
/// probe the common install locations first, then fall back to bare `git` so
/// a `PATH`-resolvable git (e.g. on Linux/CI) still works.
fn git_bin() -> String {
    const CANDIDATES: &[&str] = &[
        "/opt/homebrew/bin/git", // Apple-silicon Homebrew
        "/usr/local/bin/git",    // Intel Homebrew / manual installs
        "/usr/bin/git",          // Xcode CLT / system git
    ];
    for c in CANDIDATES {
        if std::path::Path::new(c).exists() {
            return (*c).to_string();
        }
    }
    "git".to_string()
}

/// Run `git` with args in `cwd`, returning stdout on success. Errors carry the
/// stderr so failures are diagnosable in the log.
fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new(git_bin())
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {:?} exit {}: {}",
            args,
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Parse `git diff --numstat` output into a path -> (insertions, deletions) map.
/// Binary files show as `-\t-\t<path>`, which we record as (0, 0). Renames show
/// as `old -> new` (or the NUL-delimited `-z` form); we key on the new path.
fn parse_numstat(out: &str, into: &mut std::collections::HashMap<String, (u32, u32)>) {
    for line in out.lines() {
        let mut parts = line.splitn(3, '\t');
        let ins = parts.next().unwrap_or("-");
        let del = parts.next().unwrap_or("-");
        let path = match parts.next() {
            Some(p) => p,
            None => continue,
        };
        // A rename in non-`-z` mode looks like "old => new"; strip to the new
        // path so it lines up with porcelain's key.
        let path = path
            .rsplit(" => ")
            .next()
            .unwrap_or(path)
            .trim_end_matches('}')
            .to_string();
        let ins = ins.parse::<u32>().unwrap_or(0);
        let del = del.parse::<u32>().unwrap_or(0);
        let e = into.entry(path).or_insert((0, 0));
        e.0 += ins;
        e.1 += del;
    }
}

/// Inspect `dir` as a git worktree. Never errors on "not a repo" — that's a
/// normal state reported via `is_repo: false`. Only surfaces an Err when git
/// itself is unusable, so the frontend can log and fall back to empty.
#[tauri::command]
fn git_status(dir: String) -> Result<GitStatus, String> {
    // `rev-parse --show-toplevel` is the canonical "am I in a repo?" probe: it
    // prints the worktree root and exits 0 inside a repo, non-zero outside.
    let root = match run_git(&dir, &["rev-parse", "--show-toplevel"]) {
        Ok(s) => s.trim().to_string(),
        Err(_) => {
            return Ok(GitStatus {
                is_repo: false,
                branch: String::new(),
                root: String::new(),
                files: Vec::new(),
            })
        }
    };

    // Branch name; on a detached HEAD `--abbrev-ref` yields "HEAD", so fall
    // back to a short commit sha for a friendlier label.
    let branch = match run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Ok(s) => {
            let b = s.trim().to_string();
            if b == "HEAD" {
                run_git(&dir, &["rev-parse", "--short", "HEAD"])
                    .map(|s| s.trim().to_string())
                    .unwrap_or(b)
            } else {
                b
            }
        }
        Err(_) => String::new(), // unborn branch (no commits yet)
    };

    // Line deltas: sum unstaged (working vs index) and staged (index vs HEAD).
    let mut deltas: std::collections::HashMap<String, (u32, u32)> =
        std::collections::HashMap::new();
    if let Ok(out) = run_git(&dir, &["diff", "--numstat"]) {
        parse_numstat(&out, &mut deltas);
    }
    if let Ok(out) = run_git(&dir, &["diff", "--numstat", "--cached"]) {
        parse_numstat(&out, &mut deltas);
    }

    // Porcelain v1 is the stable, script-friendly listing of every changed path
    // with its two-char XY status. Format: "XY <path>" (renames use
    // "XY orig -> new"). We key the new path and attach any line delta.
    let mut files = Vec::new();
    if let Ok(out) = run_git(&dir, &["status", "--porcelain"]) {
        for line in out.lines() {
            if line.len() < 3 {
                continue;
            }
            let status = line[..2].to_string();
            let rest = &line[3..];
            // For renames the porcelain path is "orig -> new"; take the new one.
            let path = rest.rsplit(" -> ").next().unwrap_or(rest).to_string();
            let (insertions, deletions) = deltas.get(&path).copied().unwrap_or((0, 0));
            files.push(GitFile {
                path,
                status,
                insertions,
                deletions,
            });
        }
    }

    Ok(GitStatus {
        is_repo: true,
        branch,
        root,
        files,
    })
}

// ============================================================================
// AI sidebar — chat completion proxy
// ============================================================================
// The WebView can't call third-party LLM endpoints directly (CORS + we don't
// want the API key exposed to arbitrary page script). This command is the one
// egress point: the frontend hands us an already-assembled OpenAI-compatible
// request (base url + key + model + messages) and we relay it with reqwest.
// Non-streaming for now (P1) — the whole assistant turn comes back in one shot;
// a streaming variant can be added later without changing this contract.

/// One chat message in the OpenAI `/chat/completions` shape.
#[derive(serde::Deserialize, serde::Serialize)]
struct AiMessage {
    role: String,
    content: String,
}

/// A chat request from the frontend. `base_url` is the API root
/// (e.g. `https://api.openai.com/v1`); we append `/chat/completions`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiChatRequest {
    /// wire protocol: "openai" (default) or "anthropic".
    #[serde(default = "default_provider_kind")]
    kind: String,
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<AiMessage>,
}

/// Default provider kind for requests that predate the `kind` field.
fn default_provider_kind() -> String {
    "openai".to_string()
}

/// True when the provider speaks the Anthropic Messages API.
fn is_anthropic(kind: &str) -> bool {
    kind.eq_ignore_ascii_case("anthropic")
}

/// Anthropic API version header value. Pinned; bump deliberately.
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Anthropic requires an explicit output cap (OpenAI defaults it). Generous
/// enough for chat + agent replies without risking a runaway bill.
const ANTHROPIC_MAX_TOKENS: u64 = 4096;

// --- Anthropic <-> OpenAI translation ---------------------------------------
// The frontend only ever speaks the OpenAI shape; these helpers adapt it to and
// from the Anthropic Messages API so an Anthropic provider is a drop-in.

/// Split OpenAI-style `AiMessage`s into (system_prompt, anthropic_messages).
/// Anthropic takes the system prompt as a top-level field and only allows
/// user/assistant turns in `messages`.
fn anthropic_from_simple(messages: &[AiMessage]) -> (String, Vec<serde_json::Value>) {
    let mut system = String::new();
    let mut out = Vec::new();
    for m in messages {
        if m.role == "system" {
            if !system.is_empty() {
                system.push_str("\n\n");
            }
            system.push_str(&m.content);
        } else {
            out.push(serde_json::json!({ "role": m.role, "content": m.content }));
        }
    }
    (system, out)
}

/// Translate an OpenAI-shape message array (which may include assistant
/// `tool_calls` and `tool`-role results) into Anthropic's (system, messages)
/// form. Tool results become `tool_result` blocks inside a user message;
/// assistant tool calls become `tool_use` blocks.
fn anthropic_from_openai_messages(
    messages: &serde_json::Value,
) -> (String, Vec<serde_json::Value>) {
    let mut system = String::new();
    let mut out: Vec<serde_json::Value> = Vec::new();
    let Some(arr) = messages.as_array() else {
        return (system, out);
    };
    for m in arr {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
        match role {
            "system" => {
                if let Some(c) = m.get("content").and_then(|c| c.as_str()) {
                    if !system.is_empty() {
                        system.push_str("\n\n");
                    }
                    system.push_str(c);
                }
            }
            "tool" => {
                // A tool result. Anthropic carries these as tool_result blocks
                // in a user message; merge consecutive results into one.
                let block = serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": m.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or(""),
                    "content": m.get("content").and_then(|v| v.as_str()).unwrap_or(""),
                });
                if let Some(last) = out.last_mut() {
                    if last.get("role").and_then(|r| r.as_str()) == Some("user") {
                        if let Some(blocks) =
                            last.get_mut("content").and_then(|c| c.as_array_mut())
                        {
                            blocks.push(block);
                            continue;
                        }
                    }
                }
                out.push(serde_json::json!({ "role": "user", "content": [block] }));
            }
            "assistant" => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if let Some(text) = m.get("content").and_then(|c| c.as_str()) {
                    if !text.is_empty() {
                        blocks.push(serde_json::json!({ "type": "text", "text": text }));
                    }
                }
                if let Some(calls) = m.get("tool_calls").and_then(|c| c.as_array()) {
                    for call in calls {
                        let id = call.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let func = call.get("function");
                        let name = func
                            .and_then(|f| f.get("name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let args_str = func
                            .and_then(|f| f.get("arguments"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("{}");
                        let input: serde_json::Value =
                            serde_json::from_str(args_str).unwrap_or(serde_json::json!({}));
                        blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": id,
                            "name": name,
                            "input": input,
                        }));
                    }
                }
                out.push(serde_json::json!({ "role": "assistant", "content": blocks }));
            }
            // user (and any unknown role) → plain string content.
            _ => {
                let content = m.get("content").cloned().unwrap_or(serde_json::json!(""));
                out.push(serde_json::json!({ "role": "user", "content": content }));
            }
        }
    }
    (system, out)
}

/// Translate an OpenAI `tools` array into Anthropic's tool schema
/// (`{name, description, input_schema}` per entry).
fn anthropic_tools_from_openai(tools: &serde_json::Value) -> serde_json::Value {
    let Some(arr) = tools.as_array() else {
        return serde_json::json!([]);
    };
    let mapped: Vec<serde_json::Value> = arr
        .iter()
        .filter_map(|t| {
            let f = t.get("function")?;
            Some(serde_json::json!({
                "name": f.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                "description": f.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                "input_schema": f.get("parameters").cloned().unwrap_or(serde_json::json!({
                    "type": "object", "properties": {}
                })),
            }))
        })
        .collect();
    serde_json::Value::Array(mapped)
}

/// Concatenate the `text` blocks of an Anthropic `content` array into one
/// string (used for the non-streaming chat reply).
fn anthropic_text(content: &serde_json::Value) -> String {
    let mut out = String::new();
    if let Some(arr) = content.as_array() {
        for block in arr {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    out.push_str(t);
                }
            }
        }
    }
    out
}

/// Convert an Anthropic message response (`content` blocks + `stop_reason`)
/// into the OpenAI assistant-message shape the frontend expects
/// (`{role, content, tool_calls}`).
fn anthropic_response_to_openai_message(resp: &serde_json::Value) -> serde_json::Value {
    let mut text = String::new();
    let mut tool_calls: Vec<serde_json::Value> = Vec::new();
    if let Some(arr) = resp.get("content").and_then(|c| c.as_array()) {
        for block in arr {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        text.push_str(t);
                    }
                }
                Some("tool_use") => {
                    let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                    tool_calls.push(serde_json::json!({
                        "id": id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": input.to_string(),
                        },
                    }));
                }
                _ => {}
            }
        }
    }
    let mut msg = serde_json::json!({ "role": "assistant" });
    msg["content"] = if text.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::String(text)
    };
    if !tool_calls.is_empty() {
        msg["tool_calls"] = serde_json::Value::Array(tool_calls);
    }
    msg
}

/// Relay a chat completion to the provider and return the assistant's reply
/// text. Handles both OpenAI-compatible endpoints and the Anthropic Messages
/// API (selected by `req.kind`). Errors are stringified for the frontend.
#[tauri::command]
async fn ai_chat(req: AiChatRequest) -> Result<String, String> {
    let base = req.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("AI base URL is empty — configure a provider first".into());
    }
    if req.api_key.trim().is_empty() {
        return Err("AI API key is empty — configure a provider first".into());
    }

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("build http client: {e}"))?;

    if is_anthropic(&req.kind) {
        let url = format!("{base}/v1/messages");
        let (system, messages) = anthropic_from_simple(&req.messages);
        let mut body = serde_json::json!({
            "model": req.model,
            "messages": messages,
            "max_tokens": ANTHROPIC_MAX_TOKENS,
            "stream": false,
        });
        if !system.is_empty() {
            body["system"] = serde_json::Value::String(system);
        }
        let resp = client
            .post(&url)
            .header("x-api-key", req.api_key.trim())
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("request to {url} failed: {e}"))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("read response body: {e}"))?;
        if !status.is_success() {
            let snippet: String = text.chars().take(500).collect();
            return Err(format!("provider returned {status}: {snippet}"));
        }
        let parsed: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("parse response json: {e}"))?;
        let content = anthropic_text(parsed.get("content").unwrap_or(&serde_json::Value::Null));
        if content.is_empty() {
            let snippet: String = text.chars().take(500).collect();
            return Err(format!("no assistant content in response: {snippet}"));
        }
        return Ok(content);
    }

    let url = format!("{base}/chat/completions");

    let body = serde_json::json!({
        "model": req.model,
        "messages": req.messages,
        "stream": false,
    });

    let resp = client
        .post(&url)
        .bearer_auth(req.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request to {url} failed: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("read response body: {e}"))?;

    if !status.is_success() {
        // Surface the provider's error payload verbatim (truncated) — it usually
        // explains bad key / unknown model / rate limit far better than a code.
        let snippet: String = text.chars().take(500).collect();
        return Err(format!("provider returned {status}: {snippet}"));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse response json: {e}"))?;
    let content = parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| {
            let snippet: String = text.chars().take(500).collect();
            format!("no assistant content in response: {snippet}")
        })?;

    Ok(content.to_string())
}

// ----------------------------------------------------------------------------
// Streaming variant (P2). Same request shape as `ai_chat` plus a `stream_id`
// the frontend uses to cancel, and a Tauri `Channel` we push deltas down. We
// send `stream: true` and parse the OpenAI SSE framing (`data: {json}\n\n`,
// terminated by `data: [DONE]`), emitting each content delta as it arrives.
// The whole assistant turn is assembled on the frontend from the deltas.

/// One event pushed to the frontend over the streaming channel. Tagged so the
/// TS side can switch on `event`.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
enum AiStreamEvent {
    /// An incremental slice of assistant text.
    Delta { text: String },
    /// The stream finished normally.
    Done,
    /// The stream ended with an error (message is user-facing).
    Error { message: String },
}

/// Cancellation registry: a `stream_id` maps to a flag the running stream polls
/// between chunks. `ai_chat_cancel` flips it; the stream then stops and emits
/// `Done`. Kept minimal (a boolean per active stream) — streams are short-lived.
static AI_CANCELS: OnceLock<Mutex<HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>> =
    OnceLock::new();

fn ai_cancels() -> &'static Mutex<HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>> {
    AI_CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiStreamRequest {
    #[serde(default = "default_provider_kind")]
    kind: String,
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<AiMessage>,
    /// Opaque id the frontend picks; used to cancel this specific stream.
    stream_id: String,
}

/// Extract the text delta from one parsed OpenAI SSE chunk
/// (`choices[0].delta.content`), or None if this chunk carries no text.
fn delta_text(chunk: &serde_json::Value) -> Option<String> {
    chunk
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("delta"))
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
}

/// Extract the text delta from one parsed Anthropic SSE chunk. Text arrives as
/// `content_block_delta` events whose `delta.type` is `text_delta`.
fn anthropic_delta_text(chunk: &serde_json::Value) -> Option<String> {
    let delta = chunk.get("delta")?;
    if delta.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
        return delta.get("text").and_then(|t| t.as_str()).map(String::from);
    }
    None
}

/// Stream a chat completion, pushing `AiStreamEvent`s down `on_event`. Returns
/// Ok(()) once the stream ends (normally, cancelled, or errored — the error is
/// delivered as an `Error` event, not as an `Err`, so the channel always sees a
/// terminal event).
#[tauri::command]
async fn ai_chat_stream(
    req: AiStreamRequest,
    on_event: Channel<AiStreamEvent>,
) -> Result<(), String> {
    use futures_util::StreamExt;

    let base = req.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        let _ = on_event.send(AiStreamEvent::Error {
            message: "AI base URL is empty — configure a provider first".into(),
        });
        return Ok(());
    }
    if req.api_key.trim().is_empty() {
        let _ = on_event.send(AiStreamEvent::Error {
            message: "AI API key is empty — configure a provider first".into(),
        });
        return Ok(());
    }
    let anthropic = is_anthropic(&req.kind);
    let (url, body) = if anthropic {
        let (system, messages) = anthropic_from_simple(&req.messages);
        let mut body = serde_json::json!({
            "model": req.model,
            "messages": messages,
            "max_tokens": ANTHROPIC_MAX_TOKENS,
            "stream": true,
        });
        if !system.is_empty() {
            body["system"] = serde_json::Value::String(system);
        }
        (format!("{base}/v1/messages"), body)
    } else {
        (
            format!("{base}/chat/completions"),
            serde_json::json!({
                "model": req.model,
                "messages": req.messages,
                "stream": true,
            }),
        )
    };

    // Register a cancel flag for this stream id.
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    ai_cancels()
        .lock()
        .unwrap()
        .insert(req.stream_id.clone(), cancel.clone());
    // Always deregister on exit, however we leave this function.
    let _guard = CancelGuard {
        id: req.stream_id.clone(),
    };

    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error {
                message: format!("build http client: {e}"),
            });
            return Ok(());
        }
    };

    let request = if anthropic {
        client
            .post(&url)
            .header("x-api-key", req.api_key.trim())
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
    } else {
        client.post(&url).bearer_auth(req.api_key.trim()).json(&body)
    };
    let resp = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error {
                message: format!("request to {url} failed: {e}"),
            });
            return Ok(());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(500).collect();
        let _ = on_event.send(AiStreamEvent::Error {
            message: format!("provider returned {status}: {snippet}"),
        });
        return Ok(());
    }

    // SSE chunks can split mid-line across network reads, so accumulate raw
    // bytes in a buffer and only parse complete `\n`-terminated lines.
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let _ = on_event.send(AiStreamEvent::Error {
                    message: format!("stream read error: {e}"),
                });
                return Ok(());
            }
        };
        buf.push_str(&String::from_utf8_lossy(&bytes));
        // Process every complete line currently in the buffer.
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            let Some(payload) = line.strip_prefix("data:") else {
                continue; // comments / blank lines / event: fields
            };
            let payload = payload.trim();
            if payload == "[DONE]" {
                let _ = on_event.send(AiStreamEvent::Done);
                return Ok(());
            }
            if payload.is_empty() {
                continue;
            }
            if let Ok(chunk) = serde_json::from_str::<serde_json::Value>(payload) {
                if anthropic {
                    // Anthropic streams typed events; a `message_stop` marks the
                    // end (there's no `[DONE]` sentinel).
                    if chunk.get("type").and_then(|t| t.as_str()) == Some("message_stop") {
                        let _ = on_event.send(AiStreamEvent::Done);
                        return Ok(());
                    }
                    if let Some(text) = anthropic_delta_text(&chunk) {
                        if !text.is_empty() {
                            let _ = on_event.send(AiStreamEvent::Delta { text });
                        }
                    }
                } else if let Some(text) = delta_text(&chunk) {
                    if !text.is_empty() {
                        let _ = on_event.send(AiStreamEvent::Delta { text });
                    }
                }
            }
        }
    }

    // Stream ended without an explicit [DONE] (cancelled or the provider just
    // closed the socket). Either way, tell the frontend we're finished.
    let _ = on_event.send(AiStreamEvent::Done);
    Ok(())
}

/// RAII cleanup so a cancel flag never leaks if the stream returns early.
struct CancelGuard {
    id: String,
}
impl Drop for CancelGuard {
    fn drop(&mut self) {
        ai_cancels().lock().unwrap().remove(&self.id);
    }
}

/// Flip the cancel flag for an in-flight stream. No-op if the id is unknown
/// (already finished) — the frontend can fire this optimistically.
#[tauri::command]
fn ai_chat_cancel(stream_id: String) {
    if let Some(flag) = ai_cancels().lock().unwrap().get(&stream_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

// ----------------------------------------------------------------------------
// Tool-calling variant (P3). The agent loop lives on the frontend (it owns the
// terminal and the approval UI); this command is a single non-streaming round
// trip that forwards an OpenAI `tools` array and returns the assistant message
// *raw* (content + any tool_calls) so the frontend can decide what to run.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiToolsRequest {
    #[serde(default = "default_provider_kind")]
    kind: String,
    base_url: String,
    api_key: String,
    model: String,
    /// Full message history, already including any prior tool results. Passed
    /// through as-is (may contain `tool_calls` / `tool` role entries), so we
    /// take it as opaque JSON rather than the strict `AiMessage` shape.
    messages: serde_json::Value,
    /// OpenAI-format tool schema array.
    tools: serde_json::Value,
}

/// One round trip with tools. Returns the assistant message object
/// (`choices[0].message`) verbatim as JSON so the frontend can read `content`
/// and/or `tool_calls`.
#[tauri::command]
async fn ai_chat_tools(req: AiToolsRequest) -> Result<serde_json::Value, String> {
    let base = req.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("AI base URL is empty — configure a provider first".into());
    }
    if req.api_key.trim().is_empty() {
        return Err("AI API key is empty — configure a provider first".into());
    }

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("build http client: {e}"))?;

    if is_anthropic(&req.kind) {
        let url = format!("{base}/v1/messages");
        let (system, messages) = anthropic_from_openai_messages(&req.messages);
        let mut body = serde_json::json!({
            "model": req.model,
            "messages": messages,
            "max_tokens": ANTHROPIC_MAX_TOKENS,
            "stream": false,
        });
        if !system.is_empty() {
            body["system"] = serde_json::Value::String(system);
        }
        if req.tools.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            body["tools"] = anthropic_tools_from_openai(&req.tools);
        }
        let resp = client
            .post(&url)
            .header("x-api-key", req.api_key.trim())
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("request to {url} failed: {e}"))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("read response body: {e}"))?;
        if !status.is_success() {
            let snippet: String = text.chars().take(500).collect();
            return Err(format!("provider returned {status}: {snippet}"));
        }
        let parsed: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("parse response json: {e}"))?;
        return Ok(anthropic_response_to_openai_message(&parsed));
    }

    let url = format!("{base}/chat/completions");

    let mut body = serde_json::json!({
        "model": req.model,
        "messages": req.messages,
        "stream": false,
    });
    // Only attach tools when non-empty — some providers reject an empty array.
    if req.tools.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        body["tools"] = req.tools;
        body["tool_choice"] = serde_json::json!("auto");
    }

    let resp = client
        .post(&url)
        .bearer_auth(req.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request to {url} failed: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("read response body: {e}"))?;

    if !status.is_success() {
        let snippet: String = text.chars().take(500).collect();
        return Err(format!("provider returned {status}: {snippet}"));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse response json: {e}"))?;
    let message = parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .cloned()
        .ok_or_else(|| {
            let snippet: String = text.chars().take(500).collect();
            format!("no assistant message in response: {snippet}")
        })?;

    Ok(message)
}

/// Make CJK/complex-script input work in the AppImage by routing GTK through the
/// bundled `xim` module.
///
/// The saga: linuxdeploy-plugin-gtk bundles its OWN `immodules.cache` (pinned via
/// `GTK_IM_MODULE_FILE`) that lists only GTK's generic modules — NOT the
/// third-party `im-fcitx5.so` / `im-ibus.so`. So an inherited `GTK_IM_MODULE=fcitx`
/// resolves to nothing loadable and GTK silently uses no IME.
///
/// The tempting fix — repoint `GTK_IM_MODULE_FILE` at the HOST cache so GTK loads
/// the host `im-fcitx5.so` — does NOT work in practice: on Ubuntu's `t64` systems
/// the host module is built against the new GLib (2.80, needs
/// `g_once_init_leave_pointer`) but the AppImage's `LD_LIBRARY_PATH` forces it onto
/// an older GLib, so the module fails to load with an undefined-symbol error. Any
/// host GTK module is an ABI hostage to whatever GLib the AppImage ships.
///
/// What DOES work (verified end-to-end): the bundled `im-xim.so`. It's the generic
/// X11 input-method module, depends only on GTK/GDK already inside the AppImage
/// (no fcitx libs, no new-GLib symbols), and fcitx/ibus both run an XIM server. So
/// in the AppImage we force `GTK_IM_MODULE=xim` and leave `GTK_IM_MODULE_FILE`
/// pointing at the bundled cache (which lists xim) — NOT the host one. `XMODIFIERS`
/// still names the real IME so XIM connects to the right server.
///
/// Runs before `tauri::Builder` (before GTK init). Acts only when the active cache
/// is the bundled/broken kind (lacks the native module but offers xim); a normal
/// desktop / .deb / .rpm cache that already lists fcitx/ibus is left untouched.
#[cfg(target_os = "linux")]
fn ensure_ime_env() {
    let Some(detected) = detect_ime() else {
        return; // no IME in play — leave a pure-ASCII setup untouched
    };

    let cache_text = std::env::var_os("GTK_IM_MODULE_FILE")
        .and_then(|p| std::fs::read_to_string(p).ok());

    match plan_ime_module(detected, cache_text.as_deref()) {
        ImePlan::LeaveAlone => {
            // Native cache is fine; just ensure GTK_IM_MODULE is set (an AppImage
            // may inherit XMODIFIERS but drop GTK_IM_MODULE).
            if std::env::var_os("GTK_IM_MODULE").is_none() {
                std::env::set_var("GTK_IM_MODULE", detected);
                std::env::set_var("QT_IM_MODULE", detected);
            }
        }
        ImePlan::UseXim => {
            logger::info(
                "main",
                &format!("bundled IM cache lacks {detected}; routing via bundled xim"),
            );
            // SAFETY: single-threaded, at the very top of main() before GTK/threads
            // read these. Keep GTK_IM_MODULE_FILE/GTK_PATH as the bundle set them so
            // the self-contained im-xim.so is what loads.
            std::env::set_var("GTK_IM_MODULE", "xim");
            std::env::set_var("QT_IM_MODULE", detected);
            if std::env::var_os("XMODIFIERS").is_none() {
                std::env::set_var("XMODIFIERS", format!("@im={detected}"));
            }
        }
    }
}

/// What `ensure_ime_env` should do for the active cache.
#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
enum ImePlan {
    /// Cache already loads the native module (or we have no cache / no xim to fall
    /// back to): don't override the module name.
    LeaveAlone,
    /// Bundled cache can't load the native module but offers xim: force xim.
    UseXim,
}

/// Decide the plan from the detected IME and the active `immodules.cache` text.
/// Pure — unit-tested without touching the filesystem or environment.
#[cfg(target_os = "linux")]
fn plan_ime_module(detected: &str, cache_text: Option<&str>) -> ImePlan {
    let Some(cache) = cache_text else {
        return ImePlan::LeaveAlone; // no cache visible — trust the inherited setup
    };
    if cache_lists_module(cache, detected) {
        return ImePlan::LeaveAlone; // native module loadable (desktop / deb / rpm)
    }
    if cache.contains("im-xim") {
        ImePlan::UseXim // bundled/broken cache but xim is available
    } else {
        ImePlan::LeaveAlone // nothing better to offer
    }
}

/// Whether an `immodules.cache` text lists a loadable module for `ime`
/// (`fcitx` / `ibus`). Pure — unit-tested without touching the filesystem.
#[cfg(target_os = "linux")]
fn cache_lists_module(cache_text: &str, ime: &str) -> bool {
    match ime {
        "fcitx" => cache_text.contains("im-fcitx"),
        "ibus" => cache_text.contains("im-ibus"),
        _ => false,
    }
}

/// Detect the IME the user runs: an inherited `GTK_IM_MODULE` wins, else an
/// `@im=` hint from `XMODIFIERS`, else a scan of the process list.
#[cfg(target_os = "linux")]
fn detect_ime() -> Option<&'static str> {
    let from = |s: &str| {
        let s = s.to_ascii_lowercase();
        if s.contains("fcitx") {
            Some("fcitx")
        } else if s.contains("ibus") {
            Some("ibus")
        } else {
            None
        }
    };
    std::env::var("GTK_IM_MODULE")
        .ok()
        .and_then(|v| from(&v))
        .or_else(|| std::env::var("XMODIFIERS").ok().and_then(|v| from(&v)))
        .or_else(detect_running_ime)
}

/// Detect a running input-method daemon by process name. Returns the GTK module
/// name (`fcitx` / `ibus`) or None. Scans `ps` output rather than relying on
/// `pgrep` pattern flags, which vary across distros.
#[cfg(target_os = "linux")]
fn detect_running_ime() -> Option<&'static str> {
    let listing = std::process::Command::new("ps")
        .arg("-eo")
        .arg("comm")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&listing.stdout);
    let mut has_fcitx = false;
    let mut has_ibus = false;
    for line in text.lines() {
        let name = line.trim();
        if name == "fcitx5" || name == "fcitx" {
            has_fcitx = true;
        } else if name == "ibus-daemon" {
            has_ibus = true;
        }
    }
    if has_fcitx {
        Some("fcitx")
    } else if has_ibus {
        Some("ibus")
    } else {
        None
    }
}

#[cfg(all(test, target_os = "linux"))]
mod ime_tests {
    use super::{cache_lists_module, plan_ime_module, ImePlan};

    // A bundled linuxdeploy-plugin-gtk cache: generic modules only, no fcitx.
    const BUNDLED_CACHE: &str = r#"
"im-xim.so"
"xim" "X Input Method" "gtk30" "/usr/share/locale" "ko:ja:th:zh"
"im-wayland.so"
"wayland" "Wayland" "gtk30" "" ""
"#;

    // A host cache that does include fcitx5.
    const HOST_CACHE: &str = r#"
"/usr/lib/x86_64-linux-gnu/gtk-3.0/3.0.0/immodules/im-fcitx5.so"
"fcitx" "Fcitx5" "fcitx5" "/usr/locale" "ja:ko:zh:*"
"im-xim.so"
"xim" "X Input Method" "gtk30" "" "ko:ja:th:zh"
"#;

    #[test]
    fn cache_lists_module_matches_native_so() {
        assert!(cache_lists_module(HOST_CACHE, "fcitx"));
        assert!(!cache_lists_module(BUNDLED_CACHE, "fcitx"));
        assert!(!cache_lists_module(BUNDLED_CACHE, "ibus"));
        let ibus = "\"/x/immodules/im-ibus.so\"\n\"ibus\" \"IBus\"\n";
        assert!(cache_lists_module(ibus, "ibus"));
        assert!(!cache_lists_module(ibus, "fcitx"));
        // Never treat a non-native protocol name as a loadable native module.
        assert!(!cache_lists_module(HOST_CACHE, "xim"));
    }

    #[test]
    fn bundled_cache_routes_fcitx_via_xim() {
        // The AppImage case: native module absent, but xim is available.
        assert_eq!(plan_ime_module("fcitx", Some(BUNDLED_CACHE)), ImePlan::UseXim);
        assert_eq!(plan_ime_module("ibus", Some(BUNDLED_CACHE)), ImePlan::UseXim);
    }

    #[test]
    fn native_cache_is_left_alone() {
        assert_eq!(plan_ime_module("fcitx", Some(HOST_CACHE)), ImePlan::LeaveAlone);
    }

    #[test]
    fn no_cache_is_left_alone() {
        assert_eq!(plan_ime_module("fcitx", None), ImePlan::LeaveAlone);
    }

    #[test]
    fn cache_without_native_or_xim_is_left_alone() {
        let bare = "\"im-cedilla.so\"\n\"cedilla\" \"Cedilla\" \"gtk30\" \"\" \"\"\n";
        assert_eq!(plan_ime_module("fcitx", Some(bare)), ImePlan::LeaveAlone);
    }
}

fn main() {
    logger::info(
        "main",
        &format!("yterminal {} starting", env!("CARGO_PKG_VERSION")),
    );
    #[cfg(target_os = "linux")]
    ensure_ime_env();
    tauri::Builder::default()
        .manage(pty::PtyState::default())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            default_shell,
            config_file_path,
            read_config,
            write_config,
            list_fonts,
            refresh_fonts,
            process_cwd,
            pane_process_tree,
            agent_session_id,
            process_env,
            path_is_file,
            read_text_file,
            git_status,
            ai_chat,
            ai_chat_stream,
            ai_chat_cancel,
            ai_chat_tools,
            scrollback_save,
            scrollback_load_all,
            scrollback_clear,
            scrollback_prune,
            logger::log_event,
            logger::set_log_verbose,
            logger::get_log_verbose,
            logger::log_dir_path,
            logger::clear_logs,
            logger::export_logs,
            pty::pty_spawn,
            pty::pty_read,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_exitstatus,
            open_devtools
        ])
        .run(tauri::generate_context!())
        .expect("error while running yterminal");
}
