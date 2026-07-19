use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

pub fn data_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(path).join("yterminal");
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("yterminal");
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local")
        .join("share")
        .join("yterminal")
}

pub fn database_path() -> PathBuf {
    data_dir().join("agent.db")
}

/// Keep the socket path short: Darwin limits Unix-domain paths to roughly
/// 104 bytes, so an Application Support path can fail for long usernames.
pub fn socket_path() -> PathBuf {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join("yterminal").join("agent.sock");
    }
    #[cfg(target_os = "linux")]
    if let Some(uid) = std::env::var("UID").ok().or_else(|| {
        std::process::Command::new("id")
            .arg("-u")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
    }) {
        let runtime = PathBuf::from("/run/user").join(uid);
        if runtime.is_dir() {
            return runtime.join("yterminal").join("agent.sock");
        }
    }
    let identity = std::env::var("HOME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "unknown".into());
    let mut hasher = DefaultHasher::new();
    identity.hash(&mut hasher);
    // LaunchAgent and an SSH login can inherit different TMPDIR values on
    // macOS. Use the shared short /tmp namespace plus a HOME-derived private
    // directory so both processes deterministically find the same socket.
    PathBuf::from("/tmp")
        .join(format!("yterminal-{:016x}", hasher.finish()))
        .join("agent.sock")
}
