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
    let all = enumerate_processes();
    let mut tree = descendants_of(pid, &all);
    if !tree.iter().any(|process| is_tmux_client(&process.argv)) {
        return tree;
    }
    let mut seen = tree
        .iter()
        .map(|process| process.pid)
        .collect::<HashSet<_>>();
    for server in all.iter().filter(|process| is_tmux_server(&process.argv)) {
        for child in descendants_of(server.pid, &all) {
            if seen.insert(child.pid) {
                tree.push(child);
            }
        }
    }
    tree
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
    for raw in argv {
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
        let lower = raw.to_ascii_lowercase();
        if lower.contains("@anthropic-ai/claude-code") || lower.contains("claude-code/cli") {
            return Some("claude");
        }
        if lower.contains("@openai/codex") || lower.contains("/codex/") {
            return Some("codex");
        }
        if lower.contains("opencode-ai") || lower.contains("/opencode/") {
            return Some("opencode");
        }
    }
    None
}

pub fn resolve_agent_session(kind: &str, cwd: &str, pid: u32) -> Option<String> {
    let home = home_dir()?;
    if kind == "claude" {
        let dir = home.join(".claude/projects").join(claude_escape_cwd(cwd));
        let path = process_open_files(pid)
            .into_iter()
            .find(|path| {
                path.starts_with(&dir) && path.extension().is_some_and(|ext| ext == "jsonl")
            })
            .or_else(|| newest_file_in(&dir, |name| name.ends_with(".jsonl")))?;
        return session_id_from_jsonl_tail(&path).or_else(|| {
            path.file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
        });
    }
    let (root, prefix) = match kind {
        "codex" => (home.join(".codex").join("sessions"), Some("rollout-")),
        "opencode" => (
            std::env::var_os("OPENCODE_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".local/share/opencode")),
            Some("ses_"),
        ),
        _ => return None,
    };
    if kind == "codex" {
        if let Some(session_id) = process_open_files(pid)
            .into_iter()
            .find(|path| {
                path.starts_with(&root)
                    && path
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with("rollout-"))
                    && path.extension().is_some_and(|ext| ext == "jsonl")
            })
            .and_then(|path| {
                path.file_stem()
                    .and_then(|stem| normalize_session_id(kind, &stem.to_string_lossy()))
            })
        {
            return Some(session_id);
        }
    }
    let mut candidates = Vec::new();
    collect_files(&root, &mut candidates);
    candidates.sort_by_key(|path| {
        std::fs::metadata(path)
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH)
    });
    candidates.reverse();
    for path in candidates {
        let stem = path.file_stem()?.to_string_lossy().to_string();
        if let Some(prefix) = prefix {
            if !stem.starts_with(prefix) {
                continue;
            }
        }
        if kind == "codex" && path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        // Prefer a recent session whose header mentions this cwd. Limit the
        // read so a multi-gigabyte transcript is never loaded just to resolve
        // its id; fall back to the newest correctly-shaped id below.
        if let Ok(file) = std::fs::File::open(&path) {
            use std::io::Read;
            let mut header = String::new();
            let _ = file.take(64 * 1024).read_to_string(&mut header);
            if cwd.is_empty() || header.contains(cwd) || kind == "opencode" {
                return normalize_session_id(kind, &stem);
            }
        }
    }
    None
}

fn claude_escape_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn newest_file_in(dir: &Path, accept: impl Fn(&str) -> bool) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| accept(&entry.file_name().to_string_lossy()))
        .filter_map(|entry| {
            let path = entry.path();
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

fn session_id_from_jsonl_tail(path: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(64 * 1024);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    text.lines().rev().find_map(|line| {
        let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
        value
            .get("sessionId")
            .and_then(|id| id.as_str())
            .filter(|id| !id.is_empty())
            .map(str::to_string)
    })
}

fn process_open_files(pid: u32) -> Vec<PathBuf> {
    if pid == 0 {
        return Vec::new();
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_dir(format!("/proc/{pid}/fd"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| std::fs::read_link(entry.path()).ok())
            .collect()
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/sbin/lsof")
            .args(["-p", &pid.to_string(), "-Fn"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter_map(|line| line.strip_prefix('n'))
                    .map(PathBuf::from)
                    .collect()
            })
            .unwrap_or_default()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Vec::new()
    }
}

fn normalize_session_id(kind: &str, stem: &str) -> Option<String> {
    if kind == "opencode" {
        return stem.starts_with("ses_").then(|| stem.to_string());
    }
    let id = stem.rsplit('/').next().unwrap_or(stem);
    let uuid = id.len().ge(&36).then(|| id[id.len() - 36..].to_string())?;
    let valid = uuid.chars().enumerate().all(|(index, ch)| match index {
        8 | 13 | 18 | 23 => ch == '-',
        _ => ch.is_ascii_hexdigit(),
    });
    valid.then_some(uuid)
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
    let tracked = run_git(dir, &["diff", "HEAD", "--", path]).unwrap_or_default();
    if !tracked.trim().is_empty() {
        return Ok(limit_text(tracked, MAX_GIT_DIFF_BYTES));
    }
    let output = std::process::Command::new(git_bin())
        .arg("-C")
        .arg(dir)
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

fn collect_files(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, output);
        } else {
            output.push(path);
        }
    }
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn claude_project_and_jsonl_session_are_resolved_without_loading_the_whole_file() {
        assert_eq!(claude_escape_cwd("/home/me/my app"), "-home-me-my-app");
        let path = std::env::temp_dir().join(format!("yt-session-{}", uuid::Uuid::new_v4()));
        std::fs::write(
            &path,
            "{\"sessionId\":\"old\"}\n{\"sessionId\":\"current\"}\n",
        )
        .unwrap();
        assert_eq!(
            session_id_from_jsonl_tail(&path).as_deref(),
            Some("current")
        );
        let _ = std::fs::remove_file(path);
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
}
