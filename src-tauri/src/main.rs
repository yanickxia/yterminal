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
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<AiMessage>,
}

/// Relay a chat completion to an OpenAI-compatible endpoint and return the
/// assistant's reply text. Errors are stringified for the frontend to surface.
#[tauri::command]
async fn ai_chat(req: AiChatRequest) -> Result<String, String> {
    let base = req.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("AI base URL is empty — configure a provider first".into());
    }
    if req.api_key.trim().is_empty() {
        return Err("AI API key is empty — configure a provider first".into());
    }
    let url = format!("{base}/chat/completions");

    let body = serde_json::json!({
        "model": req.model,
        "messages": req.messages,
        "stream": false,
    });

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("build http client: {e}"))?;

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

fn main() {
    logger::info(
        "main",
        &format!("yterminal {} starting", env!("CARGO_PKG_VERSION")),
    );
    tauri::Builder::default()
        .manage(pty::PtyState::default())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
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
            ai_chat,
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
