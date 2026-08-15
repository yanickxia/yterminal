use std::io;
use std::time::Duration;

const SIGNAL_POLL_INTERVAL: Duration = Duration::from_millis(50);
const HUP_GRACE: Duration = Duration::from_millis(400);
const TERM_GRACE: Duration = Duration::from_millis(600);
const KILL_GRACE: Duration = Duration::from_secs(2);

/// Identifies every process still attached to one PTY-created POSIX session.
///
/// `portable-pty` starts the shell with `setsid()`, so the shell pid is also
/// the session id. Full-screen programs can move into their own foreground
/// process group while retaining this session id. Signalling only the shell
/// pid therefore leaks those programs; signalling all members of this session
/// preserves the terminal ownership boundary without touching detached daemons.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtyProcessSession {
    root_pid: libc::pid_t,
    session_id: libc::pid_t,
}

impl PtyProcessSession {
    pub fn from_root(root_pid: u32) -> Option<Self> {
        let root_pid = libc::pid_t::try_from(root_pid).ok()?;
        if root_pid <= 1 || root_pid == std::process::id() as libc::pid_t {
            return None;
        }
        let session_id = unsafe { libc::getsid(root_pid) };
        // portable-pty establishes the shell as the session leader. Requiring
        // this invariant is a safety belt against signalling a reused pid.
        (session_id == root_pid).then_some(Self {
            root_pid,
            session_id,
        })
    }

    /// Gracefully terminate the whole PTY session, then escalate if a TUI or
    /// one of its helpers ignores the earlier signal. The foreground process
    /// group is retained as a fallback for a transient process-list failure.
    pub async fn terminate(self, foreground_pgid: Option<libc::pid_t>) -> Result<(), String> {
        let stages = [
            (libc::SIGHUP, HUP_GRACE),
            (libc::SIGTERM, TERM_GRACE),
            (libc::SIGKILL, KILL_GRACE),
        ];
        let mut last_error = None;

        for (signal, grace) in stages {
            if let Err(error) = self.signal(signal, foreground_pgid).await {
                last_error = Some(error);
            }
            let deadline = tokio::time::Instant::now() + grace;
            loop {
                match self.members().await {
                    Ok(members) if members.is_empty() => return Ok(()),
                    Ok(_) => {}
                    Err(error) => last_error = Some(error),
                }
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(SIGNAL_POLL_INTERVAL).await;
                // A SIGKILL target cannot run cleanup or intentionally spawn
                // more children. Repeating the final snapshot closes the tiny
                // enumerate-then-signal race with a concurrently forking peer.
                if signal == libc::SIGKILL {
                    if let Err(error) = self.signal(signal, foreground_pgid).await {
                        last_error = Some(error);
                    }
                }
            }
        }

        let remaining = self.members().await.unwrap_or_default();
        let detail = last_error
            .map(|error| format!("; last error: {error}"))
            .unwrap_or_default();
        Err(format!(
            "PTY session {} still has live processes {:?}{detail}",
            self.session_id, remaining
        ))
    }

    async fn signal(
        self,
        signal: libc::c_int,
        foreground_pgid: Option<libc::pid_t>,
    ) -> Result<(), String> {
        tokio::task::spawn_blocking(move || self.signal_blocking(signal, foreground_pgid))
            .await
            .map_err(|error| format!("process termination task failed: {error}"))?
    }

    async fn members(self) -> Result<Vec<libc::pid_t>, String> {
        tokio::task::spawn_blocking(move || live_session_members(self.session_id))
            .await
            .map_err(|error| format!("process enumeration task failed: {error}"))?
    }

    fn signal_blocking(
        self,
        signal: libc::c_int,
        foreground_pgid: Option<libc::pid_t>,
    ) -> Result<(), String> {
        let mut members = match live_session_members(self.session_id) {
            Ok(members) => members,
            Err(error) => {
                // `ps` can fail transiently on macOS. The tty's foreground
                // group and shell are still safe, validated targets while the
                // next polling snapshot retries full session enumeration.
                if let Some(pgid) = foreground_pgid {
                    let _ = signal_group_if_owned(pgid, self.session_id, signal);
                }
                let _ = signal_pid_if_owned(self.root_pid, self.session_id, signal);
                return Err(error);
            }
        };
        // Children first gives interactive programs a chance to unwind before
        // their shell disappears. Every pid is revalidated immediately before
        // signalling to guard against pid reuse after the process snapshot.
        members.sort_by_key(|pid| *pid == self.root_pid);
        let mut last_error = None;
        for pid in members {
            if let Err(error) = signal_pid_if_owned(pid, self.session_id, signal) {
                last_error = Some(error);
            }
        }
        last_error.map_or(Ok(()), Err)
    }
}

fn signal_pid_if_owned(
    pid: libc::pid_t,
    session_id: libc::pid_t,
    signal: libc::c_int,
) -> Result<(), String> {
    if pid <= 1 || pid == std::process::id() as libc::pid_t {
        return Ok(());
    }
    if unsafe { libc::getsid(pid) } != session_id {
        return Ok(());
    }
    if unsafe { libc::kill(pid, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!("signal {signal} pid {pid}: {error}"))
    }
}

fn signal_group_if_owned(
    pgid: libc::pid_t,
    session_id: libc::pid_t,
    signal: libc::c_int,
) -> Result<(), String> {
    if pgid <= 1 || pgid == unsafe { libc::getpgrp() } {
        return Ok(());
    }
    // A process-group leader has pid == pgid. If it has already exited, the
    // full process snapshot on the next poll remains the authoritative path.
    if unsafe { libc::getsid(pgid) } != session_id {
        return Ok(());
    }
    if unsafe { libc::kill(-pgid, signal) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!("signal {signal} process group {pgid}: {error}"))
    }
}

#[cfg(target_os = "linux")]
fn live_session_members(session_id: libc::pid_t) -> Result<Vec<libc::pid_t>, String> {
    let entries = std::fs::read_dir("/proc").map_err(|error| format!("read /proc: {error}"))?;
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<libc::pid_t>() else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let Some((state, process_session)) = parse_linux_process_stat(&stat) else {
            continue;
        };
        if process_session == session_id && state != 'Z' {
            result.push(pid);
        }
    }
    Ok(result)
}

/// Parse the state (field 3) and POSIX session id (field 6) from Linux procfs.
/// Kept platform-independent so macOS development and CI still type-check and
/// exercise the parser used only by the Linux process enumerator.
#[cfg(any(target_os = "linux", test))]
fn parse_linux_process_stat(stat: &str) -> Option<(char, libc::pid_t)> {
    // The command field is parenthesized and may itself contain spaces or `)`,
    // so split after the final closing parenthesis rather than by whitespace.
    let end = stat.rfind(')')?;
    let mut fields = stat.get(end + 2..)?.split_whitespace();
    let state = fields.next()?.chars().next()?;
    let _ppid = fields.next()?;
    let _pgrp = fields.next()?;
    let process_session = fields.next()?.parse::<libc::pid_t>().ok()?;
    Some((state, process_session))
}

#[cfg(target_os = "macos")]
fn live_session_members(session_id: libc::pid_t) -> Result<Vec<libc::pid_t>, String> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,stat="])
        .output()
        .map_err(|error| format!("spawn ps: {error}"))?;
    if !output.status.success() {
        return Err(format!("ps exited {}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let state = fields.next()?;
            // macOS/BSD ps has no portable POSIX session-id column. Query the
            // kernel for each candidate; this also revalidates the pid closer
            // to the eventual signal than a textual ps snapshot would.
            (unsafe { libc::getsid(pid) } == session_id && !state.starts_with('Z')).then_some(pid)
        })
        .collect())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn live_session_members(_session_id: libc::pid_t) -> Result<Vec<libc::pid_t>, String> {
    Err("PTY session enumeration is unsupported on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    struct ProcessCleanup(PtyProcessSession);

    impl Drop for ProcessCleanup {
        fn drop(&mut self) {
            let _ = self.0.signal_blocking(libc::SIGKILL, None);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn termination_reaches_children_outside_the_shell_process_group() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "trap '' HUP TERM; set -m; sleep 300 & wait"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        let root_pid = child.process_id().unwrap();
        let target = PtyProcessSession::from_root(root_pid).unwrap();
        let cleanup = ProcessCleanup(target);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let members = loop {
            let members = target.members().await.unwrap();
            if members.len() >= 2 {
                break members;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "child process did not enter PTY session: {members:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let process_groups = members
            .iter()
            .map(|pid| unsafe { libc::getpgid(*pid) })
            .collect::<std::collections::HashSet<_>>();
        assert!(
            process_groups.len() >= 2,
            "test requires separate shell/TUI process groups: {members:?}"
        );

        // This is portable-pty 0.9's old ChildKiller behavior. Both processes
        // deliberately ignore it, demonstrating why shell-only HUP leaked the
        // foreground program and its open Codex session writer.
        assert_eq!(
            unsafe { libc::kill(root_pid as libc::pid_t, libc::SIGHUP) },
            0
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!target.members().await.unwrap().is_empty());

        target.terminate(None).await.unwrap();
        assert!(target.members().await.unwrap().is_empty());
        tokio::task::spawn_blocking(move || child.wait())
            .await
            .unwrap()
            .unwrap();
        drop(cleanup);
    }

    #[test]
    fn linux_proc_stat_parser_extracts_state_and_session() {
        assert_eq!(
            parse_linux_process_stat("4242 (name with ) paren) S 100 200 300 0 0 0"),
            Some(('S', 300))
        );
        assert_eq!(
            parse_linux_process_stat("4243 (zombie) Z 100 200 301 0 0 0"),
            Some(('Z', 301))
        );
        assert_eq!(parse_linux_process_stat("malformed"), None);
    }
}
