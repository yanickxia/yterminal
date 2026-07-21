// yterminal Tauri backend. Live PTYs and shared workspace state are owned by
// the per-user yterminal-agent; this binary hosts the GUI IPC proxy and can
// also enter the agent's daemon/connect modes for packaged installations.

#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

#[cfg(unix)]
#[path = "bin/yterminal-agent.rs"]
mod agent_cli_entry;
#[cfg(unix)]
mod agent_service;
#[cfg(unix)]
mod host_connection;
mod logger;

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
    std::fs::write(&path, contents).map_err(|e| format!("failed to write {}: {e}", path.display()))
}

/// Absolute path to Claude Code's user settings file (`~/.claude/settings.json`).
fn claude_settings_path() -> Option<std::path::PathBuf> {
    home_dir().map(|h| h.join(".claude").join("settings.json"))
}

/// Marker embedded in every hook command we install, so we can find and remove
/// exactly our entries on a re-run without touching hooks the user added.
const YT_HOOK_MARKER: &str = "yt-agent";

/// The command string for a hook that reports `state`. Env-guarded on
/// `YTERMINAL` (set by the yterminal-agent session manager) so it emits nothing in any other terminal,
/// and prints a Claude Code `terminalSequence` JSON whose value is an OSC 777
/// notification carrying `notify;yt-agent;<state>`. Claude Code writes that
/// sequence through its own PTY; the agent and xterm both parse it per-pane.
/// No `jq` dependency — the state is literal.
fn yt_hook_command(state: &str) -> String {
    format!(
        "[ -n \"$YTERMINAL\" ] && printf '%s' '{{\"terminalSequence\":\"\\u001b]777;notify;yt-agent;{state}\\u0007\"}}'"
    )
}

/// One `{matcher?, hooks:[{type:command, command}]}` group for `state`.
fn yt_hook_group(matcher: Option<&str>, state: &str) -> serde_json::Value {
    let hook = serde_json::json!({ "type": "command", "command": yt_hook_command(state) });
    match matcher {
        Some(m) => serde_json::json!({ "matcher": m, "hooks": [hook] }),
        None => serde_json::json!({ "hooks": [hook] }),
    }
}

/// True if a hook group is one of ours (any nested command carries the marker).
fn is_yt_hook_group(group: &serde_json::Value) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|arr| {
            arr.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(YT_HOOK_MARKER))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Install (or, when `enable` is false, remove) the yterminal agent-status
/// hooks in `~/.claude/settings.json`. Idempotent: our entries are identified
/// by the `yt-agent` marker and always stripped first, so re-running never
/// duplicates them and the user's own hooks are preserved. Best-effort — a
/// missing/malformed file is treated as an empty object; only a write failure
/// returns Err.
#[tauri::command]
fn install_claude_hooks(enable: bool) -> Result<(), String> {
    let Some(path) = claude_settings_path() else {
        return Ok(());
    };
    // Read-or-init. A malformed file is left alone (return Ok) rather than
    // clobbered — we don't own this file.
    let mut root: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(s) if s.trim().is_empty() => serde_json::json!({}),
        Ok(s) => match serde_json::from_str(&s) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => return Err(format!("failed to read {}: {e}", path.display())),
    };
    if !root.is_object() {
        return Ok(());
    }

    // The events we drive, with the (event, matcher, state) tuples.
    let specs: [(&str, Option<&str>, &str); 4] = [
        ("UserPromptSubmit", None, "working"),
        ("Notification", Some("idle_prompt"), "idle"),
        ("Notification", Some("permission_prompt"), "permission"),
        ("SessionEnd", None, "ended"),
    ];

    let obj = root.as_object_mut().unwrap();
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks = hooks.as_object_mut().unwrap();

    // Strip our previous entries from every event array first (idempotency).
    for arr in hooks.values_mut() {
        if let Some(list) = arr.as_array_mut() {
            list.retain(|g| !is_yt_hook_group(g));
        }
    }

    if enable {
        for (event, matcher, state) in specs {
            let entry = hooks
                .entry(event.to_string())
                .or_insert_with(|| serde_json::json!([]));
            if let Some(list) = entry.as_array_mut() {
                list.push(yt_hook_group(matcher, state));
            }
        }
    }

    // Drop event arrays we emptied so we don't leave `"SessionEnd": []` litter.
    hooks.retain(|_, v| v.as_array().map(|a| !a.is_empty()).unwrap_or(true));

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    }
    let pretty = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("failed to serialize settings: {e}"))?;
    std::fs::write(&path, pretty).map_err(|e| format!("failed to write {}: {e}", path.display()))
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
/// session can reopen in the directory where the user left off. Agent-owned
/// panes use the owner-host `GetCwd(sessionId)` request; this Tauri command is
/// retained as a local compatibility fallback for non-agent callers.
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
#[derive(serde::Serialize, Clone)]
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
    process_tree_with_tmux(pid, &all)
}

/// Descendants of `pid`, PLUS the panes tmux hosts on this client's behalf.
///
/// Why the extra step: tmux does NOT fork the programs running in its panes off
/// the client shell. The client (`tmux attach`, or the shell that ran `tmux`)
/// talks to a long-lived **tmux server** over a socket, and the server is the
/// real parent of every pane's shell + whatever runs in it (e.g. `claude`). So
/// a plain fork-tree walk from the pane's shell pid never reaches the agent —
/// it lives under the server, a sibling branch entirely. When we spot a tmux
/// *client* anywhere in the pane's own subtree, we fold in the descendants of
/// every tmux *server* process too, so agent detection sees the pane contents.
fn process_tree_with_tmux(pid: u32, all: &[ProcInfo]) -> Vec<ProcInfo> {
    let mut tree = descendants_of(pid, all);
    // Is a tmux client running in this pane? (`tmux`, `tmux attach`, …). The
    // server shows up as `tmux: server` / `tmux -C` etc.; we treat any non-
    // server tmux proc in the subtree as a client that implies attached panes.
    let has_client = tree.iter().any(|p| is_tmux_client(&p.argv));
    if !has_client {
        return tree;
    }
    let mut seen: std::collections::HashSet<u32> = tree.iter().map(|p| p.pid).collect();
    for srv in all.iter().filter(|p| is_tmux_server(&p.argv)) {
        for d in descendants_of(srv.pid, all) {
            if seen.insert(d.pid) {
                tree.push(d);
            }
        }
    }
    tree
}

/// True when this argv looks like a tmux *client* invocation (attaches to /
/// spawns a session), as opposed to the server. Basename must be `tmux` and it
/// must NOT be the server form (`tmux: server`, or an explicit `-D`/server run).
fn is_tmux_client(argv: &[String]) -> bool {
    is_tmux_proc(argv) && !is_tmux_server(argv)
}

/// True when this argv is the tmux *server* process. tmux rewrites its own
/// argv to `tmux: server` once daemonized; also match an explicit server run.
fn is_tmux_server(argv: &[String]) -> bool {
    let Some(first) = argv.first() else {
        return false;
    };
    // The daemonized server sets argv[0] to "tmux: server" (with the colon).
    if first.starts_with("tmux:") {
        return true;
    }
    is_tmux_proc(argv) && argv.iter().any(|a| a == "-D")
}

/// True when argv[0]'s basename is `tmux` (any invocation form).
fn is_tmux_proc(argv: &[String]) -> bool {
    let Some(first) = argv.first() else {
        return false;
    };
    // strip "tmux:" server-rewrite prefix before basename-matching.
    let head = first.split(':').next().unwrap_or(first);
    let base = head.rsplit(['/', '\\']).next().unwrap_or(head);
    base == "tmux"
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
fn descendants_of(root: u32, all: &[ProcInfo]) -> Vec<ProcInfo> {
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
    all.iter()
        .enumerate()
        .filter(|(i, _)| keep.contains(i))
        .map(|(_, p)| p.clone())
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
/// "opencode"), bound to `cwd` where the agent needs it (Claude). `pid` is the
/// detected agent process, used to pin the *exact* session file that process
/// is writing (so multiple agents sharing one cwd each resume their own
/// session); pass 0 when unknown. Returns the id string, or `None` if no
/// session store is found.
#[tauri::command]
fn agent_session_id(kind: String, cwd: String, pid: u32) -> Option<String> {
    match kind.as_str() {
        "claude" => claude_session_id(&cwd, pid),
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

/// Claude stores every session for a given cwd as a separate `<uuid>.jsonl`
/// under `~/.claude/projects/<escaped-cwd>/`. To resume the *right* one when
/// several agents share a cwd (or old sessions linger), we pin the file the
/// detected process actually holds open:
///
///   1. If `pid` is live, inspect its open files (Linux `/proc/<pid>/fd`,
///      macOS `lsof`) and take the `.jsonl` inside this project dir — that's
///      the session this exact process is writing.
///   2. Otherwise (pid unknown / no matching fd), fall back to the newest
///      `.jsonl` by mtime, the historic behavior.
///
/// The id is the file stem, but we cross-check it against the `sessionId`
/// recorded on the file's last JSONL line and prefer that when present — the
/// stem can drift from the in-file id if Claude ever renames on fork.
fn claude_session_id(cwd: &str, pid: u32) -> Option<String> {
    let home = home_dir()?;
    let dir = home
        .join(".claude")
        .join("projects")
        .join(claude_escape_cwd(cwd));

    let path = claude_session_file_for_pid(&dir, pid)
        .or_else(|| newest_file_in(&dir, |n| n.ends_with(".jsonl")))?;

    // Prefer the in-file sessionId (authoritative); fall back to the stem.
    session_id_from_jsonl(&path)
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
}

/// Among the files `pid` has open, return the one that is a `.jsonl` inside
/// `dir` (Claude's project session store). `None` when pid is 0, the process
/// is gone, or it holds no matching file.
fn claude_session_file_for_pid(dir: &std::path::Path, pid: u32) -> Option<std::path::PathBuf> {
    if pid == 0 {
        return None;
    }
    process_open_files(pid).into_iter().find(|open| {
        open.starts_with(dir) && open.extension().map(|e| e == "jsonl").unwrap_or(false)
    })
}

/// The absolute paths of regular files a process currently has open.
///
/// Linux: resolve each symlink under `/proc/<pid>/fd`.
/// macOS: `lsof -p <pid> -Fn` and take the `n`-prefixed name lines.
/// Other: empty.
fn process_open_files(pid: u32) -> Vec<std::path::PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let mut out = Vec::new();
        let fd_dir = format!("/proc/{pid}/fd");
        if let Ok(rd) = std::fs::read_dir(&fd_dir) {
            for entry in rd.flatten() {
                if let Ok(target) = std::fs::read_link(entry.path()) {
                    out.push(target);
                }
            }
        }
        out
    }
    #[cfg(target_os = "macos")]
    {
        let out = match std::process::Command::new("/usr/sbin/lsof")
            .args(["-p", &pid.to_string(), "-Fn"])
            .output()
        {
            Ok(o) if o.status.success() => o.stdout,
            _ => return Vec::new(),
        };
        String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|l| l.strip_prefix('n'))
            .map(std::path::PathBuf::from)
            .collect()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        Vec::new()
    }
}

/// Read the `sessionId` field off the last non-empty JSONL line of `path`.
/// Claude records it on every event line, so the tail is authoritative even
/// if the filename ever diverges. `None` if the file is unreadable or no line
/// carries a `sessionId`.
fn session_id_from_jsonl(path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    for line in text.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(id) = v.get("sessionId").and_then(|s| s.as_str()) {
                if !id.is_empty() {
                    return Some(id.to_string());
                }
            }
        }
    }
    None
}

/// Codex: newest `rollout-*.jsonl` under `$CODEX_HOME`/`~/.codex/sessions`; the
/// session id is the trailing UUID of the filename
/// (`rollout-<ISO-ts>-<uuid>.jsonl`).
fn codex_session_id() -> Option<String> {
    let base = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".codex")))?;
    let dir = base.join("sessions");
    let (_, path) = newest_file_recursive(&dir, &|n| {
        n.starts_with("rollout-") && n.ends_with(".jsonl")
    })?;
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
    let conn =
        rusqlite::Connection::open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
    // WAL mode lets readers and writers proceed without blocking each other,
    // important if we later run background reads on the UI thread.
    let _: Result<String, _> =
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0));
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
    let placeholders = vec!["?"; live_pane_ids.len()].join(",");
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
/// are empty and the frontend hides the sidebar content. `camelCase` rename so
/// the field lands as `isRepo` for the TS `GitStatus` interface — without it
/// serde emits snake_case `is_repo`, the frontend reads `isRepo` as `undefined`,
/// and the sidebar wrongly shows "Not a git repository".
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
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
            logger::debug("git", &format!("git_bin resolved to {c}"));
            return (*c).to_string();
        }
    }
    logger::debug(
        "git",
        "git_bin fell back to bare `git` (no candidate path existed)",
    );
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
        .map_err(|e| {
            let msg = format!("spawn git {args:?} in {cwd:?}: {e}");
            logger::error("git", &msg);
            msg
        })?;
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
    logger::info("git", &format!("git_status invoked for dir={dir:?}"));
    // `rev-parse --show-toplevel` is the canonical "am I in a repo?" probe: it
    // prints the worktree root and exits 0 inside a repo, non-zero outside.
    let root = match run_git(&dir, &["rev-parse", "--show-toplevel"]) {
        Ok(s) => s.trim().to_string(),
        Err(e) => {
            logger::warn(
                "git",
                &format!("rev-parse --show-toplevel failed for dir={dir:?}: {e} -> is_repo:false"),
            );
            return Ok(GitStatus {
                is_repo: false,
                branch: String::new(),
                root: String::new(),
                files: Vec::new(),
            });
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

    logger::info(
        "git",
        &format!(
            "git_status ok dir={dir:?} root={root:?} branch={branch:?} files={}",
            files.len()
        ),
    );
    Ok(GitStatus {
        is_repo: true,
        branch,
        root,
        files,
    })
}

/// Unified diff for a single path in `dir`'s worktree, as a plain string ready
/// for the sidebar to render. Covers three cases:
///   * tracked changes (staged and/or unstaged) → `git diff HEAD -- <path>`,
///     which shows the full delta from the last commit regardless of the index.
///   * a brand-new untracked file → `HEAD` has nothing to diff against, so fall
///     back to `git diff --no-index /dev/null <path>`, presenting the whole file
///     as additions. `--no-index` exits 1 when the files differ (the normal
///     case here), so we read stdout directly instead of via `run_git` (which
///     treats a non-zero exit as an error).
///   * nothing to show → empty string (the frontend renders "No diff").
/// `path` is repo-root-relative (as returned by `git_status`). `dir` may be any
/// directory inside the worktree, so resolve the top level before applying the
/// pathspec; otherwise a terminal in a subdirectory would make Git look for
/// `<subdirectory>/<repo-relative-path>` and return an empty diff.
#[tauri::command]
fn git_diff(dir: String, path: String) -> Result<String, String> {
    logger::info("git", &format!("git_diff dir={dir:?} path={path:?}"));

    let root = run_git(&dir, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();

    // Tracked changes vs HEAD (staged + unstaged in one view).
    let tracked = run_git(&root, &["diff", "HEAD", "--", &path]).unwrap_or_default();
    if !tracked.trim().is_empty() {
        return Ok(tracked);
    }

    // Untracked / new file: diff against an empty file so the whole content
    // shows as additions. `--no-index` returns exit 1 on difference, which is
    // expected — capture stdout without failing on the non-zero status.
    let out = std::process::Command::new(git_bin())
        .arg("-C")
        .arg(&root)
        .args(["diff", "--no-index", "--", "/dev/null", &path])
        .output()
        .map_err(|e| {
            let msg = format!("spawn git diff --no-index in {root:?}: {e}");
            logger::error("git", &msg);
            msg
        })?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ============================================================================
// "Open with" — launch the repo (or a file) in an external IDE/editor.
//
// We keep a small catalog of well-known editors, each with a set of absolute
// CLI candidate paths (Homebrew arm64 / Intel / a couple of common installs)
// plus a macOS `.app` bundle name for the `open -a` fallback. `list_editors`
// returns only the ones actually installed so the UI can show a live menu;
// `open_in_editor` launches the chosen one against a path.
// ============================================================================

/// One entry in the editor catalog exposed to the frontend.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorInfo {
    id: String,
    label: String,
}

/// Static catalog: (id, label, CLI candidate paths, macOS .app bundle name).
const EDITORS: &[(&str, &str, &[&str], &str)] = &[
    (
        "vscode",
        "VS Code",
        &[
            "/opt/homebrew/bin/code",
            "/usr/local/bin/code",
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        ],
        "Visual Studio Code",
    ),
    (
        "cursor",
        "Cursor",
        &["/opt/homebrew/bin/cursor", "/usr/local/bin/cursor"],
        "Cursor",
    ),
    (
        "zed",
        "Zed",
        &["/opt/homebrew/bin/zed", "/usr/local/bin/zed"],
        "Zed",
    ),
    (
        "sublime",
        "Sublime Text",
        &["/opt/homebrew/bin/subl", "/usr/local/bin/subl"],
        "Sublime Text",
    ),
    (
        "idea",
        "IntelliJ IDEA",
        &["/opt/homebrew/bin/idea", "/usr/local/bin/idea"],
        "IntelliJ IDEA",
    ),
    (
        "webstorm",
        "WebStorm",
        &["/opt/homebrew/bin/webstorm", "/usr/local/bin/webstorm"],
        "WebStorm",
    ),
    (
        "trae",
        "Trae",
        &["/opt/homebrew/bin/trae", "/usr/local/bin/trae"],
        "Trae",
    ),
    (
        "trae-cn",
        "Trae CN",
        &["/opt/homebrew/bin/trae-cn", "/usr/local/bin/trae-cn"],
        "Trae CN",
    ),
];

/// First existing CLI path for an editor entry, if any.
fn editor_cli(candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .find(|c| std::path::Path::new(c).exists())
        .map(|c| (*c).to_string())
}

/// True if the macOS `.app` bundle for `app_name` exists (user or system).
fn editor_app_installed(app_name: &str) -> bool {
    let bundle = format!("{app_name}.app");
    ["/Applications", "/System/Applications"]
        .iter()
        .any(|dir| std::path::Path::new(dir).join(&bundle).exists())
        || home_dir()
            .map(|h| h.join("Applications").join(&bundle).exists())
            .unwrap_or(false)
}

/// Editors that are actually installed (CLI present or `.app` bundle found).
#[tauri::command]
fn list_editors() -> Vec<EditorInfo> {
    EDITORS
        .iter()
        .filter(|(_, _, cli, app)| editor_cli(cli).is_some() || editor_app_installed(app))
        .map(|(id, label, _, _)| EditorInfo {
            id: (*id).to_string(),
            label: (*label).to_string(),
        })
        .collect()
}

/// Launch `path` in the given editor. Prefers the editor's CLI (best behavior —
/// reuses/opens the folder as a project); falls back to macOS `open -a <App>`.
#[tauri::command]
fn open_in_editor(editor: String, path: String) -> Result<(), String> {
    logger::info(
        "editor",
        &format!("open_in_editor editor={editor:?} path={path:?}"),
    );
    let entry = EDITORS
        .iter()
        .find(|(id, ..)| *id == editor)
        .ok_or_else(|| format!("unknown editor {editor:?}"))?;
    let (_, _, candidates, app_name) = entry;

    if let Some(cli) = editor_cli(candidates) {
        return std::process::Command::new(&cli)
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| {
                let msg = format!("spawn {cli} {path:?}: {e}");
                logger::error("editor", &msg);
                msg
            });
    }

    // macOS fallback: open the folder/file with the registered application.
    std::process::Command::new("/usr/bin/open")
        .args(["-a", app_name])
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| {
            let msg = format!("open -a {app_name:?} {path:?}: {e}");
            logger::error("editor", &msg);
            msg
        })
}

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
                        if let Some(blocks) = last.get_mut("content").and_then(|c| c.as_array_mut())
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
        client
            .post(&url)
            .bearer_auth(req.api_key.trim())
            .json(&body)
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

// ----------------------------------------------------------------------------
// deb self-update (Linux only).
//
// The Tauri updater only knows how to replace an AppImage on Linux — a .deb
// install lives at a package-manager path and the updater's downloaded bytes
// fail its `is_deb()` sniff ("invalid updater binary format"). So for a
// deb-installed app we run our own path: download the .deb, VERIFY its minisign
// signature against the same public key baked into tauri.conf.json, then install
// it with `pkexec dpkg -i` (a polkit GUI auth prompt). Verification is
// mandatory because we hand the file to root.

/// Base64-wrapped minisign PUBLIC key — identical to `plugins.updater.pubkey`
/// in tauri.conf.json. Public by nature (it only verifies), so embedding it is
/// safe; keeping a copy here avoids parsing the bundled config at runtime.
/// If the signing key is ever rotated, update BOTH places.
const UPDATER_PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEYyODMxRDk0NzU0MjRBOTEKUldTUlNrSjFsQjJEOHV4ZVNROHJVL1NTMTFIL0FJVk43YzRzYW1laGxyZlFydnFMc0kvZXF6WEoK";

/// Which install flavor is running, so the frontend picks the right updater path.
/// `appimage`/`deb`/`rpm` on Linux; `other` = macOS/Windows (Tauri updater
/// handles those natively) or an unrecognized Linux layout.
#[tauri::command]
fn install_kind() -> String {
    #[cfg(not(target_os = "linux"))]
    {
        "other".to_string()
    }
    #[cfg(target_os = "linux")]
    {
        // AppImage runtime sets APPIMAGE to the mounted image path.
        if std::env::var_os("APPIMAGE").is_some() {
            return "appimage".to_string();
        }
        // Otherwise ask dpkg whether our own binary is owned by a package.
        if let Ok(exe) = std::env::current_exe() {
            let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
            if let Ok(out) = std::process::Command::new("dpkg")
                .arg("-S")
                .arg(&exe)
                .output()
            {
                if out.status.success() {
                    return "deb".to_string();
                }
            }
            // rpm-based systems: rpm -qf <exe> exits 0 when owned by a package.
            if let Ok(out) = std::process::Command::new("rpm")
                .arg("-qf")
                .arg(&exe)
                .output()
            {
                if out.status.success() {
                    return "rpm".to_string();
                }
            }
        }
        "other".to_string()
    }
}

/// Decode a base64 blob (minisign keys/sigs are stored base64-wrapped in the
/// Tauri manifest). Pure — no IO — so the verify path is unit-testable.
fn decode_b64(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| format!("base64 decode: {e}"))
}

/// Verify `data` against a base64-wrapped Tauri `.sig` using the embedded
/// public key. Returns Ok(()) only on a valid signature. Pure (no IO).
fn verify_minisign(data: &[u8], sig_b64: &str) -> Result<(), String> {
    verify_minisign_with(data, sig_b64, UPDATER_PUBKEY_B64)
}

/// Same as `verify_minisign` but with an explicit base64 public key, so tests
/// can exercise the decode/verify/tamper logic with a throwaway keypair (we
/// don't hold the release private key that matches `UPDATER_PUBKEY_B64`).
fn verify_minisign_with(data: &[u8], sig_b64: &str, pubkey_b64: &str) -> Result<(), String> {
    let pk_pem =
        String::from_utf8(decode_b64(pubkey_b64)?).map_err(|e| format!("pubkey utf8: {e}"))?;
    let sig_pem =
        String::from_utf8(decode_b64(sig_b64)?).map_err(|e| format!("signature utf8: {e}"))?;
    let pk = minisign_verify::PublicKey::decode(pk_pem.trim())
        .map_err(|e| format!("decode public key: {e}"))?;
    let sig = minisign_verify::Signature::decode(sig_pem.trim())
        .map_err(|e| format!("decode signature: {e}"))?;
    pk.verify(data, &sig, false)
        .map_err(|_| "signature verification failed".to_string())
}

/// Result of a deb self-update attempt. `installed` = pkexec ran dpkg to
/// completion (the caller then prompts a restart). `downloaded_path` set with
/// `installed:false` = pkexec was unavailable, so we left the verified .deb on
/// disk for the user to install by hand.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DebUpdateResult {
    installed: bool,
    downloaded_path: String,
}

/// Progress event pushed to the frontend while the .deb downloads, so the
/// update dialog can show a real progress bar instead of jumping straight to
/// the pkexec password prompt. Tagged so the TS side can switch on `event`.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
enum DebProgressEvent {
    /// Download started; `contentLength` is the total bytes when the server
    /// reported a Content-Length, else null.
    Started { content_length: Option<u64> },
    /// One downloaded chunk; `chunkLength` bytes just arrived.
    Progress { chunk_length: u64 },
    /// Bytes are all in; verification + pkexec install begin next.
    Finished,
}

/// Download the .deb from `url`, verify its `signature` (base64 Tauri `.sig`),
/// and install it via `pkexec dpkg -i`. Errors out (WITHOUT installing) if the
/// signature doesn't verify — the file is about to be handed to root. Streams
/// download progress down `on_progress` so the UI can render a progress bar.
#[tauri::command]
async fn install_deb_update(
    url: String,
    signature: String,
    on_progress: Channel<DebProgressEvent>,
) -> Result<DebUpdateResult, String> {
    use futures_util::StreamExt;
    logger::info("updater", &format!("install_deb_update url={url:?}"));

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("build http client: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download deb: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download deb: HTTP {}", resp.status()));
    }

    // Stream the body so we can report progress. reqwest exposes Content-Length
    // up front when the server sends it; GitHub's release CDN does.
    let total = resp.content_length();
    let _ = on_progress.send(DebProgressEvent::Started {
        content_length: total,
    });
    let mut stream = resp.bytes_stream();
    let mut bytes: Vec<u8> = Vec::with_capacity(total.unwrap_or(0) as usize);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("read deb body: {e}"))?;
        let _ = on_progress.send(DebProgressEvent::Progress {
            chunk_length: chunk.len() as u64,
        });
        bytes.extend_from_slice(&chunk);
    }
    let _ = on_progress.send(DebProgressEvent::Finished);

    // Verify BEFORE touching disk / root.
    verify_minisign(&bytes, &signature)?;
    logger::info("updater", "deb signature verified");

    // Write to a predictable temp path.
    let mut path = std::env::temp_dir();
    path.push("yterminal-update.deb");
    std::fs::write(&path, &bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    let path_str = path.to_string_lossy().to_string();

    // pkexec pops a polkit auth dialog and runs dpkg as root. If pkexec is
    // absent, leave the verified file for a manual `sudo dpkg -i`.
    let pkexec = which_bin("pkexec");
    let Some(pkexec) = pkexec else {
        logger::warn(
            "updater",
            "pkexec not found; leaving verified deb for manual install",
        );
        return Ok(DebUpdateResult {
            installed: false,
            downloaded_path: path_str,
        });
    };

    let status = std::process::Command::new(pkexec)
        .arg("dpkg")
        .arg("-i")
        .arg(&path)
        .status()
        .map_err(|e| format!("run pkexec dpkg: {e}"))?;
    if !status.success() {
        return Err(format!(
            "dpkg install failed (exit {}). The verified package is at {path_str}",
            status.code().unwrap_or(-1)
        ));
    }
    logger::info("updater", "deb installed via pkexec dpkg -i");
    Ok(DebUpdateResult {
        installed: true,
        downloaded_path: path_str,
    })
}

/// Fetch the updater manifest (latest.json) over HTTP and return its raw body.
///
/// Why this exists: the frontend used to `fetch()` this URL directly, but the
/// WebView (tauri://localhost) is CORS-bound and GitHub's
/// `releases/latest/download/latest.json` 302-redirects to a different-origin
/// CDN — webkit2gtk blocks that cross-origin redirect, so the deb self-update
/// path failed with "TypeError: Load failed". reqwest here is NOT CORS-bound
/// and follows the redirect fine, so we do the fetch server-side and hand the
/// JSON back to the store.
#[tauri::command]
async fn fetch_latest_json(url: String) -> Result<String, String> {
    logger::info("updater", &format!("fetch_latest_json url={url:?}"));
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("build http client: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("fetch latest.json: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("fetch latest.json: HTTP {}", resp.status()));
    }
    resp.text()
        .await
        .map_err(|e| format!("read latest.json body: {e}"))
}

/// First matching absolute path for a bare command name (PATH may be minimal
/// when launched from a desktop/Dock), else None. Linux-only helper.
#[cfg(target_os = "linux")]
fn which_bin(name: &str) -> Option<std::path::PathBuf> {
    for dir in ["/usr/bin", "/bin", "/usr/local/bin"] {
        let p = std::path::Path::new(dir).join(name);
        if p.exists() {
            return Some(p);
        }
    }
    // fall back to PATH resolution
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let p = std::path::Path::new(dir).join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}
#[cfg(not(target_os = "linux"))]
fn which_bin(_name: &str) -> Option<std::path::PathBuf> {
    None
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

    let cache_text =
        std::env::var_os("GTK_IM_MODULE_FILE").and_then(|p| std::fs::read_to_string(p).ok());

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
        assert_eq!(
            plan_ime_module("fcitx", Some(BUNDLED_CACHE)),
            ImePlan::UseXim
        );
        assert_eq!(
            plan_ime_module("ibus", Some(BUNDLED_CACHE)),
            ImePlan::UseXim
        );
    }

    #[test]
    fn native_cache_is_left_alone() {
        assert_eq!(
            plan_ime_module("fcitx", Some(HOST_CACHE)),
            ImePlan::LeaveAlone
        );
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

#[cfg(test)]
mod git_diff_tests {
    use super::{git_diff, run_git};
    use std::path::PathBuf;

    struct TestRepo(PathBuf);

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn repo_with_nested_change() -> TestRepo {
        let root = std::env::temp_dir().join(format!("yt-git-diff-{}", uuid::Uuid::new_v4()));
        let nested = root.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("file.txt"), "before\n").unwrap();

        let root_str = root.to_str().unwrap();
        run_git(root_str, &["init", "--quiet"]).unwrap();
        run_git(root_str, &["add", "--", "nested/file.txt"]).unwrap();
        run_git(
            root_str,
            &[
                "-c",
                "user.name=yterminal test",
                "-c",
                "user.email=test@yterminal.invalid",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "--quiet",
                "-m",
                "initial",
            ],
        )
        .unwrap();
        std::fs::write(nested.join("file.txt"), "after\n").unwrap();
        TestRepo(root)
    }

    #[test]
    fn repo_relative_diff_works_from_nested_cwd() {
        let repo = repo_with_nested_change();
        let nested = repo.0.join("nested");
        let diff = git_diff(
            nested.to_string_lossy().into_owned(),
            "nested/file.txt".into(),
        )
        .unwrap();

        assert!(diff.contains("-before"), "missing deletion in {diff:?}");
        assert!(diff.contains("+after"), "missing addition in {diff:?}");
    }
}

#[cfg(test)]
mod process_tree_tests {
    use super::{process_tree_with_tmux, ProcInfo};

    fn p(pid: u32, ppid: u32, argv: &[&str]) -> ProcInfo {
        ProcInfo {
            pid,
            ppid,
            argv: argv.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// Plain fork tree (no tmux): only the shell's own descendants come back.
    #[test]
    fn walks_plain_fork_tree() {
        let all = vec![
            p(100, 1, &["/bin/zsh"]),         // pane shell
            p(200, 100, &["node", "claude"]), // agent forked under the shell
            p(300, 1, &["/other/proc"]),      // unrelated
        ];
        let tree = process_tree_with_tmux(100, &all);
        let pids: Vec<u32> = tree.iter().map(|t| t.pid).collect();
        assert!(pids.contains(&200));
        assert!(!pids.contains(&300));
    }

    /// tmux: the agent lives under the tmux SERVER, not the pane shell. When a
    /// tmux client is present in the pane, the server's descendants are folded
    /// in so the agent is detected.
    #[test]
    fn folds_in_tmux_server_children() {
        let all = vec![
            p(100, 1, &["/bin/zsh"]),                 // pane shell
            p(150, 100, &["tmux", "attach"]),         // tmux CLIENT in the pane
            p(900, 1, &["tmux: server"]),             // long-lived server (sibling)
            p(910, 900, &["/bin/bash"]),              // shell inside a tmux window
            p(920, 910, &["node", "claude", "code"]), // the agent, under the server
        ];
        let tree = process_tree_with_tmux(100, &all);
        let pids: Vec<u32> = tree.iter().map(|t| t.pid).collect();
        // client is a direct descendant; agent is reached via the server fold-in.
        assert!(pids.contains(&150));
        assert!(pids.contains(&920));
    }

    /// No tmux client in the pane → server children are NOT folded in, so a
    /// tmux session someone else is running doesn't leak into this pane's tree.
    #[test]
    fn does_not_fold_server_without_a_client() {
        let all = vec![
            p(100, 1, &["/bin/zsh"]),         // pane shell, no tmux
            p(900, 1, &["tmux: server"]),     // server for a DIFFERENT client
            p(920, 900, &["node", "claude"]), // its agent — must not leak in
        ];
        let tree = process_tree_with_tmux(100, &all);
        let pids: Vec<u32> = tree.iter().map(|t| t.pid).collect();
        assert!(!pids.contains(&920));
    }

    /// De-dupes when the server is itself already a descendant of the pane
    /// shell (e.g. the client forked the server): no pid appears twice.
    #[test]
    fn dedupes_overlapping_descendants() {
        let all = vec![
            p(100, 1, &["/bin/zsh"]),
            p(150, 100, &["tmux"]), // client that also spawned the server
            p(900, 150, &["tmux: server"]), // server under the client
            p(920, 900, &["node", "claude"]),
        ];
        let tree = process_tree_with_tmux(100, &all);
        let mut pids: Vec<u32> = tree.iter().map(|t| t.pid).collect();
        pids.sort_unstable();
        let mut deduped = pids.clone();
        deduped.dedup();
        assert_eq!(pids, deduped, "no pid should be duplicated");
        assert!(pids.contains(&920));
    }
}

#[cfg(test)]
mod session_id_tests {
    use super::{claude_escape_cwd, claude_session_file_for_pid, session_id_from_jsonl};
    use std::io::Write;

    /// Write `content` to a fresh temp file with the given `.jsonl` stem and
    /// return its path. Uses a per-call unique dir so tests don't collide.
    fn write_temp(dir: &std::path::Path, stem: &str, content: &str) -> std::path::PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(format!("{stem}.jsonl"));
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        path
    }

    fn unique_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("yt-sess-{tag}-{nanos}"))
    }

    #[test]
    fn escape_maps_non_alnum_to_dash() {
        assert_eq!(claude_escape_cwd("/home/me/app"), "-home-me-app");
        // A leading dot and a dot-dir both collapse to single dashes.
        assert_eq!(claude_escape_cwd("/a/.session/x"), "-a--session-x");
    }

    #[test]
    fn reads_session_id_off_last_line() {
        let dir = unique_dir("lastline");
        let uuid = "7f800878-78b9-420c-bfe0-47f9cbe2ed60";
        let content = format!(
            "{{\"type\":\"user\",\"sessionId\":\"{uuid}\"}}\n\
             {{\"type\":\"assistant\",\"sessionId\":\"{uuid}\"}}\n"
        );
        let path = write_temp(&dir, uuid, &content);
        assert_eq!(session_id_from_jsonl(&path).as_deref(), Some(uuid));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn last_line_id_wins_over_stem_when_they_differ() {
        // Stem is one uuid, but the file records a different sessionId — the
        // in-file id is authoritative, so we must return it, not the stem.
        let dir = unique_dir("mismatch");
        let stem = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let real = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        let path = write_temp(&dir, stem, &format!("{{\"sessionId\":\"{real}\"}}\n"));
        assert_eq!(session_id_from_jsonl(&path).as_deref(), Some(real));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn session_id_none_when_no_field() {
        let dir = unique_dir("nofield");
        let path = write_temp(&dir, "x", "{\"type\":\"meta\"}\n\nnot json\n");
        assert_eq!(session_id_from_jsonl(&path), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pid_zero_never_matches_a_file() {
        let dir = unique_dir("pidzero");
        write_temp(&dir, "abc", "{}\n");
        // pid 0 is the "unknown" sentinel: no fd inspection, always None so the
        // caller falls back to newest-mtime.
        assert_eq!(claude_session_file_for_pid(&dir, 0), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod deb_verify_tests {
    use super::verify_minisign_with;

    // Throwaway keypair (NOT the release key) generated with
    // `tauri signer sign`, signing the bytes "hello yterminal deb update\n".
    // These exercise the base64-unwrap + minisign verify + tamper-reject path.
    const TEST_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDEzN0Q4QTkxNTU1MTVERjEKUldUeFhWRlZrWXA5RXpuWjB1SC9ObCtoMDE5L2JBT0QxZDZYalNpczhBRHBjRnRjeXgzNFRsYmwK";
    const TEST_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUeFhWRlZrWXA5RTFjaWk1WnpCc3ZTMmttVmZBMjRxeFR3alVEM2tiUjJSRTlINHovdllPU0QzWlNEdi94UHpOMkVGT1V5MXNucUZuN2JjbWZMSTNKRW5DMkl6THAvd1E4PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzgzNDAyMjk1CWZpbGU6c2FtcGxlLmRlYgorcjlSSkVpTEg4NlJSemJuZ0ZMY3dWSTRLVC9NaVdYVW96NWNWUmIyQnZ3My9nTWhvZXJmUFgyTzNHZ0xrb2hhaGl3RGZaUWlkZVlGRE9rYjYyeFBCUT09Cg==";
    const SIGNED_DATA: &[u8] = b"hello yterminal deb update\n";

    #[test]
    fn accepts_a_valid_signature() {
        assert!(verify_minisign_with(SIGNED_DATA, TEST_SIG, TEST_PUBKEY).is_ok());
    }

    #[test]
    fn rejects_tampered_data() {
        let mut bad = SIGNED_DATA.to_vec();
        bad.push(b'X');
        assert!(verify_minisign_with(&bad, TEST_SIG, TEST_PUBKEY).is_err());
    }

    #[test]
    fn rejects_wrong_key() {
        // A syntactically valid but different key (the release pubkey) must not
        // verify a signature made by the throwaway key.
        assert!(verify_minisign_with(SIGNED_DATA, TEST_SIG, super::UPDATER_PUBKEY_B64).is_err());
    }

    #[test]
    fn errors_on_garbage_base64() {
        assert!(verify_minisign_with(SIGNED_DATA, "!!!not base64!!!", TEST_PUBKEY).is_err());
    }
}

fn main() {
    #[cfg(unix)]
    {
        let command = std::env::args().nth(1);
        if command.as_deref() == Some("--agent-daemon") {
            let runtime = tokio::runtime::Runtime::new().expect("create yterminal-agent runtime");
            let result = runtime.block_on(yterminal::agent::run_daemon(None, None));
            if let Err(error) = result {
                eprintln!("yterminal-agent: {error}");
                std::process::exit(1);
            }
            return;
        }
        if command
            .as_deref()
            .is_some_and(agent_cli_entry::handles_command)
        {
            let runtime =
                tokio::runtime::Runtime::new().expect("create yterminal-agent CLI runtime");
            if let Err(error) = runtime.block_on(agent_cli_entry::run()) {
                eprintln!("yterminal-agent: {error}");
                std::process::exit(1);
            }
            return;
        }
    }
    logger::info(
        "main",
        &format!("yterminal {} starting", env!("CARGO_PKG_VERSION")),
    );
    #[cfg(target_os = "linux")]
    ensure_ime_env();
    let builder = tauri::Builder::default();
    #[cfg(unix)]
    let builder = builder.manage(host_connection::HostConnectionState::default());
    builder
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
            install_claude_hooks,
            list_fonts,
            refresh_fonts,
            process_cwd,
            pane_process_tree,
            agent_session_id,
            process_env,
            path_is_file,
            read_text_file,
            git_status,
            git_diff,
            list_editors,
            open_in_editor,
            ai_chat,
            ai_chat_stream,
            ai_chat_cancel,
            ai_chat_tools,
            install_kind,
            install_deb_update,
            fetch_latest_json,
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
            #[cfg(unix)]
            host_connection::host_connect,
            #[cfg(unix)]
            host_connection::host_request,
            #[cfg(unix)]
            host_connection::host_notify,
            #[cfg(unix)]
            host_connection::host_disconnect,
            #[cfg(unix)]
            agent_service::agent_service_status,
            #[cfg(unix)]
            agent_service::install_agent_service,
            #[cfg(unix)]
            agent_service::start_agent_service,
            #[cfg(unix)]
            agent_service::hot_restart_agent_service,
            open_devtools
        ])
        .run(tauri::generate_context!())
        .expect("error while running yterminal");
}
