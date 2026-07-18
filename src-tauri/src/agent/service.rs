use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::agent::paths;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentServiceStatus {
    pub installed: bool,
    pub running: bool,
    pub managed: bool,
    pub version: Option<String>,
    pub binary_path: String,
    pub service_path: String,
}

pub async fn status() -> Result<AgentServiceStatus, String> {
    let running = socket_running().await;
    tokio::task::spawn_blocking(move || status_impl(running))
        .await
        .map_err(|error| format!("agent status task: {error}"))
}

pub async fn install() -> Result<AgentServiceStatus, String> {
    let running = socket_running().await;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        install_binary()?;
        install_manager_definition(running)?;
        Ok(())
    })
    .await
    .map_err(|error| format!("agent install task: {error}"))??;
    if !running {
        wait_until_running(Duration::from_secs(5)).await?;
    }
    status().await
}

/// Start the installed manager definition after a drained daemon has exited.
pub async fn start_after_drain() -> Result<AgentServiceStatus, String> {
    wait_until_stopped(Duration::from_secs(5)).await?;
    start().await
}

pub async fn start() -> Result<AgentServiceStatus, String> {
    tokio::task::spawn_blocking(start_manager)
        .await
        .map_err(|error| format!("agent start task: {error}"))??;
    wait_until_running(Duration::from_secs(5)).await?;
    status().await
}

pub async fn restart() -> Result<AgentServiceStatus, String> {
    start().await
}

pub async fn stop() -> Result<AgentServiceStatus, String> {
    tokio::task::spawn_blocking(stop_manager)
        .await
        .map_err(|error| format!("agent stop task: {error}"))??;
    wait_until_stopped(Duration::from_secs(5)).await?;
    status().await
}

async fn socket_running() -> bool {
    tokio::net::UnixStream::connect(paths::socket_path())
        .await
        .is_ok()
}

async fn wait_until_running(timeout: Duration) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if socket_running().await {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("installed yterminal-agent did not start".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn wait_until_stopped(timeout: Duration) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    while socket_running().await {
        if tokio::time::Instant::now() >= deadline {
            return Err("old yterminal-agent did not stop".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".to_string())
}

fn binary_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".local/bin/yterminal-agent"))
}

#[cfg(target_os = "linux")]
fn service_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".config/systemd/user/yterminal-agent.service"))
}

#[cfg(target_os = "macos")]
fn service_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("Library/LaunchAgents/dev.yterminal.agent.plist"))
}

fn status_impl(running: bool) -> AgentServiceStatus {
    let binary = binary_path().unwrap_or_else(|_| PathBuf::from("~/.local/bin/yterminal-agent"));
    let service = service_path().unwrap_or_default();
    let version = binary
        .is_file()
        .then(|| {
            Command::new(&binary)
                .arg("version")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        })
        .flatten();
    AgentServiceStatus {
        installed: binary.is_file(),
        running,
        managed: service.is_file(),
        version,
        binary_path: binary.to_string_lossy().into_owned(),
        service_path: service.to_string_lossy().into_owned(),
    }
}

fn install_binary() -> Result<(), String> {
    let target = binary_path()?;
    if let Some(source) = std::env::var_os("YTERMINAL_AGENT_PATH")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return copy_executable(&source, &target);
    }
    let current =
        std::env::current_exe().map_err(|error| format!("current executable: {error}"))?;
    if let Some(sibling) = current
        .parent()
        .map(|parent| parent.join("yterminal-agent"))
        .filter(|path| path.is_file() && path != &current)
    {
        return copy_executable(&sibling, &target);
    }
    #[cfg(target_os = "linux")]
    if let Some(app_image) = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        let installed_image = home_dir()?.join(".local/lib/yterminal/yterminal.AppImage");
        copy_executable(&app_image, &installed_image)?;
        write_file(
            &target,
            "#!/bin/sh\nexec \"$HOME/.local/lib/yterminal/yterminal.AppImage\" \"$@\"\n",
        )?;
        return make_executable(&target);
    }
    copy_executable(&current, &target)
}

fn copy_executable(source: &Path, target: &Path) -> Result<(), String> {
    if source == target {
        return Ok(());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "agent binary has no parent".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create {}: {error}", parent.display()))?;
    let temporary = parent.join(format!(".yterminal-agent-{}.tmp", std::process::id()));
    std::fs::copy(source, &temporary).map_err(|error| {
        format!(
            "copy {} to {}: {error}",
            source.display(),
            temporary.display()
        )
    })?;
    make_executable(&temporary)?;
    std::fs::rename(&temporary, target)
        .map_err(|error| format!("install {}: {error}", target.display()))
}

fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|error| format!("chmod {}: {error}", path.display()))
}

#[cfg(target_os = "linux")]
fn install_manager_definition(agent_already_running: bool) -> Result<(), String> {
    let path = service_path()?;
    write_file(
        &path,
        "[Unit]\nDescription=yterminal workspace agent\n\n[Service]\nType=simple\nWorkingDirectory=%h\nExecStart=%h/.local/bin/yterminal-agent daemon\nRestart=on-failure\nRestartSec=1\n\n[Install]\nWantedBy=default.target\n",
    )?;
    run("systemctl", &["--user", "daemon-reload"])?;
    run(
        "systemctl",
        &["--user", "enable", "yterminal-agent.service"],
    )?;
    if !agent_already_running {
        run("systemctl", &["--user", "start", "yterminal-agent.service"])?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_manager_definition(agent_already_running: bool) -> Result<(), String> {
    let path = service_path()?;
    let binary = xml_escape(&binary_path()?.to_string_lossy());
    let stdout = xml_escape(
        &home_dir()?
            .join("Library/Logs/yterminal-agent.log")
            .to_string_lossy(),
    );
    let working_directory = xml_escape(&home_dir()?.to_string_lossy());
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>dev.yterminal.agent</string>\n<key>ProgramArguments</key><array><string>{binary}</string><string>daemon</string></array>\n<key>WorkingDirectory</key><string>{working_directory}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>StandardOutPath</key><string>{stdout}</string>\n<key>StandardErrorPath</key><string>{stdout}</string>\n</dict></plist>\n"
    );
    write_file(&path, &plist)?;
    if !agent_already_running {
        // `bootstrap` fails when launchd still has a previously crashed/stopped
        // definition loaded. `start_manager` first kickstarts that label and
        // falls back to bootstrap only when it is genuinely absent.
        start_manager()?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn start_manager() -> Result<(), String> {
    run(
        "systemctl",
        &["--user", "restart", "yterminal-agent.service"],
    )
}

#[cfg(target_os = "linux")]
fn stop_manager() -> Result<(), String> {
    run("systemctl", &["--user", "stop", "yterminal-agent.service"])
}

#[cfg(target_os = "macos")]
fn start_manager() -> Result<(), String> {
    let path = service_path()?;
    let uid = run_output("id", &["-u"])?;
    let domain = format!("gui/{}", uid.trim());
    let service = format!("{domain}/dev.yterminal.agent");
    let kicked = Command::new("launchctl")
        .args(["kickstart", "-k", &service])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if kicked {
        Ok(())
    } else {
        bootstrap_launch_agent(&path)
    }
}

#[cfg(target_os = "macos")]
fn stop_manager() -> Result<(), String> {
    let uid = run_output("id", &["-u"])?;
    let domain = format!("gui/{}", uid.trim());
    let service = format!("{domain}/dev.yterminal.agent");
    let stopped = Command::new("launchctl")
        .args(["bootout", &service])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if stopped {
        Ok(())
    } else {
        let path = service_path()?;
        run("launchctl", &["bootout", &domain, &path.to_string_lossy()])
    }
}

#[cfg(target_os = "macos")]
fn bootstrap_launch_agent(path: &Path) -> Result<(), String> {
    let uid = run_output("id", &["-u"])?;
    let domain = format!("gui/{}", uid.trim());
    run(
        "launchctl",
        &["bootstrap", &domain, &path.to_string_lossy()],
    )
}

fn write_file(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "service file has no parent".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create {}: {error}", parent.display()))?;
    std::fs::write(path, contents).map_err(|error| format!("write {}: {error}", path.display()))
}

fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("start {program}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "{} {}: {}",
        program,
        args.join(" "),
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

#[cfg(target_os = "macos")]
fn run_output(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("start {program}: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
