use crate::remote_protocol::{RemoteGitFile, RemoteGitStatus, RemoteProcessInfo};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const MAX_VIEWER_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILE_CHUNK_BYTES: u32 = 256 * 1024;
const MAX_GIT_FILES: usize = 512;
const MAX_GIT_DIFF_BYTES: usize = 768 * 1024;

pub fn process_cwd(pid: u32) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/sbin/lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-F", "n"])
            .output()
            .map_err(|e| format!("spawn lsof: {e}"))?;
        if !output.status.success() {
            return Err(format!("lsof exited {}", output.status));
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some(path) = line.strip_prefix('n') {
                if !path.trim().is_empty() {
                    return Ok(path.trim().to_string());
                }
            }
        }
        Err("cwd missing from lsof output".into())
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/cwd"))
            .map(|path| path.to_string_lossy().to_string())
            .map_err(|e| format!("read process cwd: {e}"))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        Err("process cwd is unsupported".into())
    }
}

pub fn process_tree(pid: u32) -> Vec<RemoteProcessInfo> {
    let all = process_snapshot();
    let mut tree = terminal_processes(pid, &all);
    if !tree.iter().any(|process| is_tmux_client(&process.argv)) {
        return tree;
    }
    let mut seen = tree
        .iter()
        .map(|process| process.pid)
        .collect::<HashSet<_>>();
    let clients = tree
        .iter()
        .filter(|process| is_tmux_client(&process.argv))
        .cloned()
        .collect::<Vec<_>>();
    for client in clients {
        let Some(pane_pid) = tmux_pane_for_client(&client) else {
            continue;
        };
        for child in terminal_processes(pane_pid, &all) {
            if seen.insert(child.pid) {
                tree.push(child);
            }
        }
    }
    tree
}

fn process_snapshot() -> Vec<RemoteProcessInfo> {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static CACHE: OnceLock<Mutex<Option<(Instant, Vec<RemoteProcessInfo>)>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some((at, processes)) = cache.as_ref() {
        if at.elapsed() < Duration::from_millis(250) {
            return processes.clone();
        }
    }
    let processes = enumerate_processes();
    *cache = Some((Instant::now(), processes.clone()));
    processes
}

fn tmux_pane_for_client(client: &RemoteProcessInfo) -> Option<u32> {
    let mut command = std::process::Command::new(client.argv.first()?);
    let mut args = client.argv.iter().skip(1);
    while let Some(arg) = args.next() {
        if matches!(arg.as_str(), "-L" | "-S") {
            command.arg(arg).arg(args.next()?);
        } else if (arg.starts_with("-L") || arg.starts_with("-S")) && arg.len() > 2 {
            command.arg(arg);
        } else if !arg.starts_with('-') {
            break;
        }
    }
    let output = command
        .args(["list-clients", "-F", "#{client_pid} #{pane_pid}"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            let mut fields = line.split_whitespace();
            let client_pid = fields.next()?.parse::<u32>().ok()?;
            if client_pid != client.pid {
                return None;
            }
            fields.next()?.parse().ok()
        })
}

fn process_foreground_group(pid: u32) -> Option<i32> {
    // A tmux pane belongs to the server's POSIX session. tcgetpgrp on its
    // slave TTY from our daemon would fail because it is not our controlling TTY.
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        parse_foreground_group(&stat)
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/bin/ps")
            .args(["-o", "tpgid=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let pgid = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<i32>()
            .ok()?;
        (pgid > 0).then_some(pgid)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

#[cfg(any(target_os = "linux", test))]
fn parse_foreground_group(stat: &str) -> Option<i32> {
    let pgid = stat
        .rsplit_once(") ")?
        .1
        .split_whitespace()
        .nth(5)?
        .parse::<i32>()
        .ok()?;
    (pgid > 0).then_some(pgid)
}

pub fn terminal_agent(
    processes: &[RemoteProcessInfo],
    foreground_pgid: Option<i32>,
    cached_pid: Option<u32>,
) -> (Option<(String, u32)>, bool) {
    #[cfg(unix)]
    if let Some(pgid) = foreground_pgid {
        let foreground = processes
            .iter()
            .filter(|process| unsafe { libc::getpgid(process.pid as i32) } == pgid)
            .cloned()
            .collect::<Vec<_>>();
        if let Some(leader) = foreground.iter().find(|process| process.pid == pgid as u32) {
            if let Some(kind) = classify_agent_argv(&leader.argv) {
                return (Some((kind.to_string(), leader.pid)), true);
            }
        }
        if let Some(client) = foreground
            .iter()
            .find(|process| is_tmux_client(&process.argv))
        {
            if let Some(pane_pid) = tmux_pane_for_client(client) {
                let pane_processes = terminal_processes(pane_pid, processes);
                return terminal_agent(
                    &pane_processes,
                    process_foreground_group(pane_pid),
                    cached_pid,
                );
            }
        }
        if let Some(agent) = detect_agent(&foreground) {
            return (Some(agent), true);
        }
        let held = processes
            .iter()
            .find(|process| Some(process.pid) == cached_pid)
            .and_then(|process| {
                classify_agent_argv(&process.argv).map(|kind| (kind.to_string(), process.pid))
            });
        return (held, false);
    }
    let _ = (foreground_pgid, cached_pid);
    (detect_agent(processes), false)
}

pub fn detect_agent(processes: &[RemoteProcessInfo]) -> Option<(String, u32)> {
    let by_pid = processes
        .iter()
        .map(|process| (process.pid, process))
        .collect::<HashMap<_, _>>();
    let depth = |process: &RemoteProcessInfo| {
        let mut depth = 0usize;
        let mut current = Some(process);
        let mut seen = HashSet::new();
        while let Some(item) = current {
            if !seen.insert(item.pid) {
                break;
            }
            let Some(parent) = by_pid.get(&item.ppid).copied() else {
                break;
            };
            depth += 1;
            current = Some(parent);
        }
        depth
    };
    processes
        .iter()
        .filter_map(|process| {
            classify_agent_argv(&process.argv)
                .map(|kind| (kind.to_string(), process.pid, depth(process)))
        })
        .max_by_key(|(_, _, depth)| *depth)
        .map(|(kind, pid, _)| (kind, pid))
}

fn classify_agent_argv(argv: &[String]) -> Option<&'static str> {
    let executable = argv
        .first()?
        .rsplit(['/', '\\'])
        .next()?
        .to_ascii_lowercase();
    let executable = executable
        .trim_end_matches(".exe")
        .trim_end_matches(".cmd")
        .trim_end_matches(".bat");
    if let Some(kind) = match executable {
        "claude" => Some("claude"),
        "codex" => Some("codex"),
        "opencode" => Some("opencode"),
        _ => None,
    } {
        return Some(kind);
    }
    if !matches!(executable, "node" | "nodejs" | "bun") {
        return None;
    }
    let mut args = argv.iter().skip(1);
    while let Some(raw) = args.next() {
        if ((raw.starts_with("-e") || raw.starts_with("-p")) && raw.len() > 2)
            || matches!(raw.as_str(), "-e" | "--eval" | "-p" | "--print")
            || raw.starts_with("--eval=")
            || raw.starts_with("--print=")
        {
            return None;
        }
        if matches!(raw.as_str(), "-r" | "--require" | "--import" | "--loader") {
            args.next();
            continue;
        }
        if raw.starts_with('-') {
            continue;
        }
        let mut basename = raw
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(raw)
            .to_ascii_lowercase();
        for suffix in [".exe", ".cmd", ".bat"] {
            if let Some(stripped) = basename.strip_suffix(suffix) {
                basename = stripped.to_string();
                break;
            }
        }
        match basename.as_str() {
            "claude" => return Some("claude"),
            "codex" => return Some("codex"),
            "opencode" => return Some("opencode"),
            _ => {}
        }
        let lower = raw.to_ascii_lowercase().replace('\\', "/");
        if lower.ends_with("/claude-code/cli.js") {
            return Some("claude");
        }
        if lower.contains("@openai/codex/")
            && ["/bin/codex.js", "/bin.js", "/cli.js"]
                .iter()
                .any(|suffix| lower.ends_with(suffix))
        {
            return Some("codex");
        }
        if lower.contains("opencode-ai/")
            && ["/dist/index.js", "/bin.js"]
                .iter()
                .any(|suffix| lower.ends_with(suffix))
        {
            return Some("opencode");
        }
        return None;
    }
    None
}

/// Resolve only evidence associated with this process. A recent transcript in
/// the same project can belong to another pane or a previous run.
pub fn resolve_agent_session(kind: &str, pid: u32) -> Option<String> {
    let process = process_snapshot()
        .into_iter()
        .find(|process| process.pid == pid && classify_agent_argv(&process.argv) == Some(kind))?;
    let id = match kind {
        "claude" => claude_pid_session(pid)
            .or_else(|| session_id_from_open_files(kind, process_writable_files(pid))),
        "codex" => session_id_from_open_files(kind, process_writable_files(pid)),
        _ => None,
    };
    id.or_else(|| explicit_session_id(kind, &process.argv))
}

fn claude_pid_session(pid: u32) -> Option<String> {
    use std::io::Read;

    let config = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|home| home.join(".claude")))?;
    let file = std::fs::File::open(config.join("sessions").join(format!("{pid}.json"))).ok()?;
    #[cfg(target_os = "linux")]
    {
        // Linux process start ticks restart at boot. Reject stale records
        // across reboots independently of Claude's internal boot identifier.
        let stat = std::fs::read_to_string("/proc/stat").ok()?;
        let boot_seconds = stat
            .lines()
            .find_map(|line| line.strip_prefix("btime "))?
            .trim()
            .parse::<u64>()
            .ok()?;
        let boot =
            std::time::UNIX_EPOCH.checked_add(std::time::Duration::from_secs(boot_seconds))?;
        if file.metadata().ok()?.modified().ok()? < boot {
            return None;
        }
    }
    let entry = serde_json::from_reader(file.take(16 * 1024)).ok()?;
    let (domain, start) = process_start_identity(pid)?;
    claude_session_from_record(&entry, pid, &domain, &start)
}

fn claude_session_from_record(
    entry: &serde_json::Value,
    pid: u32,
    domain: &str,
    start: &str,
) -> Option<String> {
    // These native session records may survive an unclean exit. Verify that
    // the writer is this instance of the PID, including the Linux namespace.
    let record_domain = entry.get("pidDomain")?.as_str()?;
    let record_domain = match record_domain.strip_prefix("linux:") {
        Some(value) => value.split_once(':')?.1,
        None => record_domain,
    };
    if entry.get("pid")?.as_u64()? != u64::from(pid)
        || record_domain != domain
        || entry.get("procStart")?.as_str()? != start
    {
        return None;
    }
    valid_session_id("claude", entry.get("sessionId")?.as_str()?)
}

fn process_start_identity(pid: u32) -> Option<(String, String)> {
    #[cfg(target_os = "linux")]
    {
        let proc = PathBuf::from(format!("/proc/{pid}"));
        let stat = std::fs::read_to_string(proc.join("stat")).ok()?;
        let start = stat.rsplit_once(") ")?.1.split_whitespace().nth(19)?;
        let namespace = std::fs::read_link(proc.join("ns/pid")).ok()?;
        Some((namespace.to_str()?.to_string(), start.to_string()))
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/bin/ps")
            .env("LC_ALL", "C")
            .env("TZ", "UTC")
            .args(["-p", &pid.to_string(), "-o", "lstart="])
            .output()
            .ok()?;
        let start = std::str::from_utf8(&output.stdout).ok()?.trim();
        (output.status.success() && !start.is_empty())
            .then(|| ("darwin".to_string(), start.to_string()))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

fn session_id_from_open_files(kind: &str, paths: Vec<PathBuf>) -> Option<String> {
    let mut candidates = paths.iter().filter_map(|path| {
        let stem = path.file_stem()?.to_str()?;
        match kind {
            "claude"
                if path.extension().is_some_and(|ext| ext == "jsonl")
                    && path
                        .parent()?
                        .parent()?
                        .file_name()
                        .is_some_and(|dir| dir == "projects") =>
            {
                let filename_id = valid_session_id(kind, stem)?;
                claude_transcript_session(path).or(Some(filename_id))
            }
            "codex" if path.extension().is_some_and(|ext| ext == "jsonl") => {
                let rollout = stem.strip_prefix("rollout-")?;
                let id = rollout.get(rollout.len().checked_sub(36)?..)?;
                valid_session_id(kind, id)
            }
            _ => None,
        }
    });
    let first = candidates.next()?;
    candidates
        .all(|candidate| candidate == first)
        .then_some(first)
}

fn claude_transcript_session(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).ok()?;
    let start = file.metadata().ok()?.len().saturating_sub(64 * 1024);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(64 * 1024).read_to_end(&mut bytes).ok()?;
    String::from_utf8_lossy(&bytes)
        .lines()
        .rev()
        .find_map(|line| {
            let record: serde_json::Value = serde_json::from_str(line).ok()?;
            valid_session_id("claude", record.get("sessionId")?.as_str()?)
        })
}

fn explicit_session_id(kind: &str, argv: &[String]) -> Option<String> {
    argv.iter().skip(1).enumerate().find_map(|(index, arg)| {
        let (flag, inline) = arg
            .split_once('=')
            .map_or((arg.as_str(), None), |(flag, value)| (flag, Some(value)));
        let takes_id = matches!(
            (kind, flag),
            ("claude", "--resume" | "-r" | "--session-id")
                | ("codex", "resume")
                | ("opencode", "--session" | "-s")
        );
        if !takes_id {
            return None;
        }
        let id = inline.or_else(|| argv.get(index + 2).map(String::as_str))?;
        valid_session_id(kind, id)
    })
}

fn valid_session_id(kind: &str, id: &str) -> Option<String> {
    if kind == "opencode" {
        let suffix = id.strip_prefix("ses_")?;
        return (!suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric()))
            .then(|| id.to_string());
    }
    let uuid = uuid::Uuid::try_parse(id).ok()?;
    (id.len() == 36).then(|| uuid.hyphenated().to_string())
}

fn process_writable_files(pid: u32) -> Vec<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_dir(format!("/proc/{pid}/fd"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let info = std::fs::read_to_string(
                    Path::new(&format!("/proc/{pid}/fdinfo")).join(entry.file_name()),
                )
                .ok()?;
                let flags = info.lines().find_map(|line| line.strip_prefix("flags:"))?;
                let flags = i32::from_str_radix(flags.trim(), 8).ok()?;
                (flags & libc::O_ACCMODE != libc::O_RDONLY)
                    .then(|| std::fs::read_link(entry.path()).ok())
                    .flatten()
            })
            .collect()
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/sbin/lsof")
            .args(["-nP", "-p", &pid.to_string(), "-Ffan"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| {
                let mut writable = false;
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter_map(|line| {
                        match line.as_bytes().first() {
                            Some(b'f') => writable = false,
                            Some(b'a') => writable = matches!(line, "aw" | "au"),
                            _ => {}
                        }
                        line.strip_prefix('n')
                            .filter(|_| writable)
                            .map(PathBuf::from)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        Vec::new()
    }
}

pub fn git_status(dir: &str) -> Result<RemoteGitStatus, String> {
    let root = match run_git(dir, &["rev-parse", "--show-toplevel"]) {
        Ok(root) => root.trim().to_string(),
        Err(_) => {
            return Ok(RemoteGitStatus {
                is_repo: false,
                branch: String::new(),
                root: String::new(),
                files: Vec::new(),
            })
        }
    };
    let mut branch = run_git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();
    if branch == "HEAD" {
        branch = run_git(dir, &["rev-parse", "--short", "HEAD"])
            .unwrap_or(branch)
            .trim()
            .to_string();
    }
    let mut deltas = HashMap::new();
    for args in [
        vec!["diff", "--numstat"],
        vec!["diff", "--numstat", "--cached"],
    ] {
        if let Ok(output) = run_git(dir, &args) {
            parse_numstat(&output, &mut deltas);
        }
    }
    let mut files = Vec::new();
    if let Ok(output) = run_git(dir, &["status", "--porcelain"]) {
        for line in output.lines().filter(|line| line.len() >= 3) {
            if files.len() >= MAX_GIT_FILES {
                break;
            }
            let status = line[..2].to_string();
            let path = line[3..]
                .rsplit(" -> ")
                .next()
                .unwrap_or(&line[3..])
                .to_string();
            let (insertions, deletions) = deltas.get(&path).copied().unwrap_or((0, 0));
            files.push(RemoteGitFile {
                path,
                status,
                insertions,
                deletions,
            });
        }
    }
    Ok(RemoteGitStatus {
        is_repo: true,
        branch,
        root,
        files,
    })
}

pub fn git_diff(dir: &str, path: &str) -> Result<String, String> {
    // Status paths are relative to the repository root even when the active
    // terminal is in a nested directory. Resolve that root before passing the
    // path back to Git or the cwd prefix would be applied a second time.
    let root = run_git(dir, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    let tracked = run_git(&root, &["diff", "HEAD", "--", path]).unwrap_or_default();
    if !tracked.trim().is_empty() {
        return Ok(limit_text(tracked, MAX_GIT_DIFF_BYTES));
    }
    let output = std::process::Command::new(git_bin())
        .arg("-C")
        .arg(&root)
        .args(["diff", "--no-index", "--", "/dev/null", path])
        .output()
        .map_err(|e| format!("spawn git diff: {e}"))?;
    Ok(limit_text(
        String::from_utf8_lossy(&output.stdout).into_owned(),
        MAX_GIT_DIFF_BYTES,
    ))
}

fn limit_text(mut text: String, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n… diff truncated by yterminal …\n");
    text
}

pub fn path_is_file(path: &str) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

pub fn read_text_file(path: &str) -> Result<(String, u64), String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("stat {path}: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("not a regular file: {path}"));
    }
    if metadata.len() > MAX_VIEWER_BYTES {
        return Err(format!("file exceeds {MAX_VIEWER_BYTES} bytes"));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read {path}: {e}"))?;
    if bytes.iter().take(8192).any(|byte| *byte == 0) {
        return Err("binary file".into());
    }
    Ok((
        String::from_utf8_lossy(&bytes).into_owned(),
        bytes.len() as u64,
    ))
}

pub fn read_text_file_chunk(
    path: &str,
    offset: u64,
    max_bytes: u32,
) -> Result<(Vec<u8>, u64, bool), String> {
    use std::io::{Read, Seek, SeekFrom};
    if max_bytes == 0 || max_bytes > MAX_FILE_CHUNK_BYTES {
        return Err(format!("invalid file chunk size: {max_bytes}"));
    }
    let metadata = std::fs::metadata(path).map_err(|e| format!("stat {path}: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("not a regular file: {path}"));
    }
    if metadata.len() > MAX_VIEWER_BYTES {
        return Err(format!("file exceeds {MAX_VIEWER_BYTES} bytes"));
    }
    if offset > metadata.len() {
        return Err(format!("file offset {offset} exceeds {}", metadata.len()));
    }
    let mut file = std::fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    let mut probe = [0u8; 8192];
    let probe_len = file
        .read(&mut probe)
        .map_err(|e| format!("probe {path}: {e}"))?;
    if probe[..probe_len].contains(&0) {
        return Err("binary file".into());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek {path}: {e}"))?;
    let remaining = metadata.len().saturating_sub(offset);
    let wanted = remaining.min(max_bytes as u64) as usize;
    let mut bytes = vec![0u8; wanted];
    file.read_exact(&mut bytes)
        .map_err(|e| format!("read {path}: {e}"))?;
    let eof = offset.saturating_add(bytes.len() as u64) >= metadata.len();
    Ok((bytes, metadata.len(), eof))
}

fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new(git_bin())
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn git_bin() -> &'static str {
    [
        "/opt/homebrew/bin/git",
        "/usr/local/bin/git",
        "/usr/bin/git",
    ]
    .into_iter()
    .find(|path| Path::new(path).exists())
    .unwrap_or("git")
}

fn parse_numstat(output: &str, deltas: &mut HashMap<String, (u32, u32)>) {
    for line in output.lines() {
        let mut fields = line.splitn(3, '\t');
        let insertions = fields.next().unwrap_or("-").parse().unwrap_or(0);
        let deletions = fields.next().unwrap_or("-").parse().unwrap_or(0);
        let Some(path) = fields.next() else { continue };
        let path = path
            .rsplit(" => ")
            .next()
            .unwrap_or(path)
            .trim_end_matches('}')
            .to_string();
        let entry = deltas.entry(path).or_insert((0, 0));
        entry.0 += insertions;
        entry.1 += deletions;
    }
}

fn terminal_processes(pid: u32, all: &[RemoteProcessInfo]) -> Vec<RemoteProcessInfo> {
    let mut tree = descendants_of(pid, all);
    // exec replaces the shell without changing its pid, including tmux panes
    // started directly with an agent rather than an interactive shell.
    if let Some(root) = all.iter().find(|process| process.pid == pid) {
        if classify_agent_argv(&root.argv).is_some() || is_tmux_client(&root.argv) {
            tree.insert(0, root.clone());
        }
    }
    tree
}

fn descendants_of(pid: u32, all: &[RemoteProcessInfo]) -> Vec<RemoteProcessInfo> {
    let mut parents = vec![pid];
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    while let Some(parent) = parents.pop() {
        for process in all.iter().filter(|process| process.ppid == parent) {
            if seen.insert(process.pid) {
                parents.push(process.pid);
                result.push(process.clone());
            }
        }
    }
    result
}

#[cfg(target_os = "linux")]
fn enumerate_processes() -> Vec<RemoteProcessInfo> {
    let mut result = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return result;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        let ppid = stat
            .rfind(')')
            .and_then(|end| stat[end + 2..].split_whitespace().nth(1))
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let argv: Vec<String> = std::fs::read(format!("/proc/{pid}/cmdline"))
            .ok()
            .map(|bytes| {
                bytes
                    .split(|byte| *byte == 0)
                    .filter(|part| !part.is_empty())
                    .map(|part| String::from_utf8_lossy(part).into_owned())
                    .collect()
            })
            .unwrap_or_default();
        if !argv.is_empty() {
            result.push(RemoteProcessInfo { pid, ppid, argv });
        }
    }
    result
}

#[cfg(target_os = "macos")]
fn enumerate_processes() -> Vec<RemoteProcessInfo> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output();
    output
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| {
                    let mut fields = line.split_whitespace();
                    let pid = fields.next()?.parse().ok()?;
                    let ppid = fields.next()?.parse().ok()?;
                    let argv = fields.map(str::to_string).collect::<Vec<_>>();
                    (!argv.is_empty()).then_some(RemoteProcessInfo { pid, ppid, argv })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn enumerate_processes() -> Vec<RemoteProcessInfo> {
    Vec::new()
}

fn is_tmux_client(argv: &[String]) -> bool {
    is_tmux(argv) && !is_tmux_server(argv)
}

fn is_tmux_server(argv: &[String]) -> bool {
    argv.first()
        .map(|first| first.starts_with("tmux:"))
        .unwrap_or(false)
        || (is_tmux(argv) && argv.iter().any(|arg| arg == "-D"))
}

fn is_tmux(argv: &[String]) -> bool {
    argv.first()
        .and_then(|first| first.split(':').next())
        .and_then(|first| first.rsplit('/').next())
        == Some("tmux")
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRepo(PathBuf);

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn repo_with_nested_change() -> TestRepo {
        let root = std::env::temp_dir().join(format!("yt-agent-git-{}", uuid::Uuid::new_v4()));
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
        let diff = git_diff(nested.to_str().unwrap(), "nested/file.txt").unwrap();

        assert!(diff.contains("-before"), "missing deletion in {diff:?}");
        assert!(diff.contains("+after"), "missing addition in {diff:?}");
    }

    #[test]
    fn process_descendants_are_transitive() {
        let all = vec![
            RemoteProcessInfo {
                pid: 2,
                ppid: 1,
                argv: vec!["sh".into()],
            },
            RemoteProcessInfo {
                pid: 3,
                ppid: 2,
                argv: vec!["claude".into()],
            },
            RemoteProcessInfo {
                pid: 4,
                ppid: 9,
                argv: vec!["other".into()],
            },
        ];
        let result = descendants_of(1, &all);
        assert_eq!(
            result.iter().map(|item| item.pid).collect::<Vec<_>>(),
            vec![2, 3]
        );
    }

    #[test]
    fn deepest_agent_process_wins_and_node_wrappers_are_detected() {
        let processes = vec![
            RemoteProcessInfo {
                pid: 2,
                ppid: 1,
                argv: vec![
                    "node".into(),
                    "/pkg/@anthropic-ai/claude-code/cli.js".into(),
                ],
            },
            RemoteProcessInfo {
                pid: 3,
                ppid: 2,
                argv: vec!["/usr/local/bin/codex".into()],
            },
        ];
        assert_eq!(detect_agent(&processes), Some(("codex".into(), 3)));
    }

    #[test]
    fn open_transcripts_identify_only_the_process_that_owns_them() {
        let id = "11111111-1111-4111-8111-111111111111";
        let other = "22222222-2222-4222-8222-222222222222";
        let first = PathBuf::from(format!("/sessions/rollout-date-{id}.jsonl"));
        let second = PathBuf::from(format!("/sessions/rollout-date-{other}.jsonl"));
        assert_eq!(session_id_from_open_files("codex", vec![]), None);
        assert_eq!(
            session_id_from_open_files("codex", vec![first.clone(), first.clone()]).as_deref(),
            Some(id)
        );
        assert_eq!(
            session_id_from_open_files("codex", vec![first, second]),
            None
        );
        assert_eq!(
            session_id_from_open_files(
                "claude",
                vec![format!("/.claude/projects/-work/{id}.jsonl").into()],
            )
            .as_deref(),
            Some(id)
        );
    }

    #[test]
    fn claude_uses_the_session_id_in_its_writable_transcript() {
        let fixture =
            TestRepo(std::env::temp_dir().join(format!("yt-transcript-{}", uuid::Uuid::new_v4())));
        let project = fixture.0.join("projects").join("-work");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.join("11111111-1111-4111-8111-111111111111.jsonl");
        let id = "22222222-2222-4222-8222-222222222222";
        std::fs::write(&path, format!("{{\"sessionId\":\"{id}\"}}\npartial row")).unwrap();
        assert_eq!(
            session_id_from_open_files("claude", vec![path]).as_deref(),
            Some(id)
        );
    }

    #[test]
    fn claude_pid_record_must_match_the_live_process_instance() {
        let id = "11111111-1111-4111-8111-111111111111";
        let record = serde_json::json!({
            "pid": 123, "pidDomain": "linux:boot:pid:[1]", "procStart": "1234", "sessionId": id,
        });
        assert_eq!(
            claude_session_from_record(&record, 123, "pid:[1]", "1234").as_deref(),
            Some(id)
        );
        assert_eq!(
            claude_session_from_record(&record, 123, "pid:[1]", "5678"),
            None
        );
        assert_eq!(
            claude_session_from_record(&record, 123, "pid:[2]", "1234"),
            None
        );
    }

    #[test]
    fn explicit_resume_ids_are_validated_as_shell_safe_agent_ids() {
        let argv = |args: &[&str]| {
            args.iter()
                .map(|arg| (*arg).into())
                .collect::<Vec<String>>()
        };
        assert_eq!(
            explicit_session_id("opencode", &argv(&["opencode", "--session=ses_abc123"]))
                .as_deref(),
            Some("ses_abc123")
        );
        assert_eq!(
            explicit_session_id("opencode", &argv(&["opencode", "-s", "ses_abc;pwd"])),
            None
        );
        assert_eq!(
            explicit_session_id("codex", &argv(&["codex", "resume", "--last"])),
            None
        );
    }

    #[test]
    fn binary_file_is_rejected() {
        let path = std::env::temp_dir().join(format!("yt-binary-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, [1, 0, 2]).unwrap();
        assert!(read_text_file(path.to_str().unwrap()).is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn text_file_chunks_reassemble_across_utf8_boundaries() {
        let path = std::env::temp_dir().join(format!("yt-text-{}", uuid::Uuid::new_v4()));
        let original = "a你b好c".as_bytes();
        std::fs::write(&path, original).unwrap();
        let mut offset = 0;
        let mut restored = Vec::new();
        loop {
            let (chunk, total, eof) =
                read_text_file_chunk(path.to_str().unwrap(), offset, 4).unwrap();
            assert_eq!(total, original.len() as u64);
            offset += chunk.len() as u64;
            restored.extend_from_slice(&chunk);
            if eof {
                break;
            }
        }
        assert_eq!(restored, original);
        assert!(read_text_file_chunk(path.to_str().unwrap(), 0, 0).is_err());
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn ordinary_arguments_are_not_agents() {
        for args in [
            vec!["rg", "claude", "."],
            vec!["cat", "/tmp/codex/README.md"],
            vec!["node", "-eclaude", "codex"],
            vec!["node", "script.js", "claude"],
        ] {
            assert_eq!(
                classify_agent_argv(&args.into_iter().map(str::to_string).collect::<Vec<_>>()),
                None
            );
        }
        assert_eq!(
            classify_agent_argv(&["node".into(), "/pkg/@openai/codex/bin/codex.js".into()]),
            Some("codex")
        );
    }
    #[cfg(unix)]
    #[test]
    fn foreground_agent_leader_wins_over_nested_agent() {
        let pid = std::process::id();
        let group = unsafe { libc::getpgid(pid as i32) };
        let p = vec![
            RemoteProcessInfo {
                pid: group as u32,
                ppid: 1,
                argv: vec!["codex".into()],
            },
            RemoteProcessInfo {
                pid,
                ppid: group as u32,
                argv: vec!["claude".into()],
            },
        ];
        assert_eq!(
            terminal_agent(&p, Some(group), None),
            (Some(("codex".into(), group as u32)), true)
        );
    }
    #[cfg(unix)]
    #[test]
    fn known_background_agent_is_held_without_using_foreground_screen() {
        let pid = std::process::id();
        let p = vec![RemoteProcessInfo {
            pid,
            ppid: 1,
            argv: vec!["codex".into()],
        }];
        assert_eq!(
            terminal_agent(&p, Some(i32::MAX), Some(pid)),
            (Some(("codex".into(), pid)), false)
        );
        assert_eq!(terminal_agent(&p, Some(i32::MAX), None), (None, false));
    }
    #[cfg(unix)]
    #[test]
    fn tmux_lookup_matches_the_exact_client() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("yt-tmux-test-{}", std::process::id()));
        std::fs::write(&path, "#!/bin/sh\nprintf '11 101\\n22 202\\n'\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let p = RemoteProcessInfo {
            pid: 22,
            ppid: 1,
            argv: vec![
                path.to_string_lossy().into_owned(),
                "-L".into(),
                "test".into(),
                "attach".into(),
            ],
        };
        assert_eq!(tmux_pane_for_client(&p), Some(202));
        std::fs::remove_file(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn background_tmux_client_does_not_own_the_foreground_screen() {
        let pid = std::process::id();
        let processes = vec![
            RemoteProcessInfo {
                pid,
                ppid: 1,
                argv: vec!["tmux".into()],
            },
            RemoteProcessInfo {
                pid: 101,
                ppid: 100,
                argv: vec!["codex".into()],
            },
        ];
        assert_eq!(
            terminal_agent(&processes, Some(i32::MAX), Some(101)),
            (Some(("codex".into(), 101)), false)
        );
        assert_eq!(
            terminal_agent(&processes, Some(i32::MAX), None),
            (None, false)
        );
    }

    #[test]
    fn exec_agent_and_direct_tmux_pane_roots_are_detectable() {
        let processes = vec![
            RemoteProcessInfo {
                pid: 10,
                ppid: 1,
                argv: vec!["codex".into()],
            },
            RemoteProcessInfo {
                pid: 11,
                ppid: 10,
                argv: vec!["rg".into(), "claude".into()],
            },
            RemoteProcessInfo {
                pid: 20,
                ppid: 1,
                argv: vec!["tmux".into()],
            },
            RemoteProcessInfo {
                pid: 30,
                ppid: 1,
                argv: vec!["zsh".into()],
            },
        ];
        assert_eq!(
            detect_agent(&terminal_processes(10, &processes)),
            Some(("codex".into(), 10))
        );
        assert!(is_tmux_client(&terminal_processes(20, &processes)[0].argv));
        assert!(terminal_processes(30, &processes).is_empty());
    }

    #[test]
    fn proc_stat_foreground_group_handles_parenthesized_names_and_no_tty() {
        assert_eq!(
            parse_foreground_group("42 (agent ) name) S 1 42 42 123 77 4194304"),
            Some(77)
        );
        assert_eq!(
            parse_foreground_group("42 (agent) S 1 42 42 0 -1 4194304"),
            None
        );
        assert_eq!(parse_foreground_group("42 (agent) S 1"), None);
    }
}
