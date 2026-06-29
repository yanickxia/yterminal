//! Native pseudo-terminal commands for the frontend.
//!
//! Replaces the `tauri-plugin-pty` plugin (and its tauri-pty JS package). We
//! own this layer outright so the frontend can rely on `pty.pid` being a real
//! OS child pid — that's what makes `process_cwd(pid)` (lsof / /proc) able to
//! resolve a session's actual cwd, which the upstream plugin foreclosed by
//! returning an internal session counter instead.
//!
//! Commands are exposed at the top level (no plugin namespace), invoked from
//! TS as `invoke('pty_spawn', ...)` etc.

use std::{
    collections::BTreeMap,
    ffi::OsString,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, PtyPair, PtySize};
use tauri::async_runtime::{Mutex, RwLock};

#[derive(Default)]
pub struct PtyState {
    /// Fallback id source for the (rare) case where portable-pty cannot give
    /// us a real OS pid. Keeps every session keyable even on broken platforms.
    fallback_id: AtomicU32,
    sessions: RwLock<BTreeMap<u32, Arc<Session>>>,
}

struct Session {
    pair: Mutex<PtyPair>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    reader: Mutex<Box<dyn std::io::Read + Send>>,
}

#[tauri::command]
pub async fn pty_spawn(
    file: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    state: tauri::State<'_, PtyState>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(file);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.cwd(OsString::from(cwd));
    }
    for (k, v) in env.iter() {
        cmd.env(OsString::from(k), OsString::from(v));
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    // Use the real OS pid as the session handle so the frontend can pass it
    // straight into `process_cwd(pid)`. Fallback path only fires if portable-pty
    // can't surface a pid (shouldn't happen on macOS/Linux/Windows ConPTY).
    let id = match child.process_id() {
        Some(pid) => pid,
        None => {
            let synthetic = state.fallback_id.fetch_add(1, Ordering::Relaxed);
            eprintln!("pty_spawn: no OS pid from portable-pty, using synthetic id {synthetic}");
            synthetic
        }
    };
    let child_killer = child.clone_killer();

    let session = Arc::new(Session {
        pair: Mutex::new(pair),
        child: Mutex::new(child),
        child_killer: Mutex::new(child_killer),
        writer: Mutex::new(writer),
        reader: Mutex::new(reader),
    });
    state.sessions.write().await.insert(id, session);
    Ok(id)
}

#[tauri::command]
pub async fn pty_write(
    pid: u32,
    data: String,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    session
        .writer
        .lock()
        .await
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Long-poll: blocks until the pty has data (or EOF). Frontend loops on this.
#[tauri::command]
pub async fn pty_read(
    pid: u32,
    state: tauri::State<'_, PtyState>,
) -> Result<tauri::ipc::Response, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    let mut buf = vec![0u8; 4096];
    let n = session
        .reader
        .lock()
        .await
        .read(&mut buf)
        .map_err(|e| e.to_string())?;
    if n == 0 {
        Err(String::from("EOF"))
    } else {
        buf.truncate(n);
        Ok(tauri::ipc::Response::new(buf))
    }
}

#[tauri::command]
pub async fn pty_resize(
    pid: u32,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    session
        .pair
        .lock()
        .await
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(pid: u32, state: tauri::State<'_, PtyState>) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    session
        .child_killer
        .lock()
        .await
        .kill()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Long-poll: blocks until the child exits, returns the exit code.
#[tauri::command]
pub async fn pty_exitstatus(pid: u32, state: tauri::State<'_, PtyState>) -> Result<u32, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    let exit_code = session
        .child
        .lock()
        .await
        .wait()
        .map_err(|e| e.to_string())?
        .exit_code();
    Ok(exit_code)
}
