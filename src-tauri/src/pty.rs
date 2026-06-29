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
    time::Instant,
};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, PtyPair, PtySize};
use tauri::async_runtime::{Mutex, RwLock};

use crate::logger;

/// A blocking call that holds a lock or the reader for longer than this many
/// milliseconds is suspicious — log it at WARN so it stands out in an export.
/// The "hang and can't type" symptom should surface here: if `pty_read` blocks
/// for seconds while the async runtime can't service `pty_write`, that gap is
/// exactly what proves the starvation theory.
const SLOW_MS: u128 = 250;

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
    logger::info(
        "pty",
        &format!(
            "pty_spawn: file={file:?} args={args:?} cols={cols} rows={rows} cwd={cwd:?} env_keys={}",
            env.len()
        ),
    );
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            logger::error("pty", &format!("pty_spawn: openpty failed: {e}"));
            e.to_string()
        })?;
    let writer = pair.master.take_writer().map_err(|e| {
        logger::error("pty", &format!("pty_spawn: take_writer failed: {e}"));
        e.to_string()
    })?;
    let reader = pair.master.try_clone_reader().map_err(|e| {
        logger::error("pty", &format!("pty_spawn: try_clone_reader failed: {e}"));
        e.to_string()
    })?;

    let mut cmd = CommandBuilder::new(file);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.cwd(OsString::from(cwd));
    }
    for (k, v) in env.iter() {
        cmd.env(OsString::from(k), OsString::from(v));
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        logger::error("pty", &format!("pty_spawn: spawn_command failed: {e}"));
        e.to_string()
    })?;

    // Use the real OS pid as the session handle so the frontend can pass it
    // straight into `process_cwd(pid)`. Fallback path only fires if portable-pty
    // can't surface a pid (shouldn't happen on macOS/Linux/Windows ConPTY).
    let id = match child.process_id() {
        Some(pid) => pid,
        None => {
            let synthetic = state.fallback_id.fetch_add(1, Ordering::Relaxed);
            logger::warn(
                "pty",
                &format!("pty_spawn: no OS pid from portable-pty, using synthetic id {synthetic}"),
            );
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
    let count = state.sessions.read().await.len();
    logger::info(
        "pty",
        &format!("pty_spawn: session ready pid={id} live_sessions={count}"),
    );
    Ok(id)
}

#[tauri::command]
pub async fn pty_write(
    pid: u32,
    data: String,
    state: tauri::State<'_, PtyState>,
) -> Result<(), String> {
    let nbytes = data.len();
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or_else(|| {
            logger::warn("pty", &format!("pty_write: unknown pid={pid} ({nbytes}B dropped)"));
            "Unavailable pid"
        })?
        .clone();
    // Time the wait for the writer lock separately from the write itself. If
    // keystrokes "don't go in", either this lock is contended (something else
    // holds the writer) or the underlying write blocks — this tells us which.
    let t0 = Instant::now();
    let mut writer = session.writer.lock().await;
    let lock_ms = t0.elapsed().as_millis();
    let t1 = Instant::now();
    let res = writer.write_all(data.as_bytes());
    let write_ms = t1.elapsed().as_millis();
    res.map_err(|e| {
        logger::error("pty", &format!("pty_write: pid={pid} write failed: {e}"));
        e.to_string()
    })?;
    if lock_ms >= SLOW_MS || write_ms >= SLOW_MS {
        logger::warn(
            "pty",
            &format!("pty_write: SLOW pid={pid} bytes={nbytes} lock_wait={lock_ms}ms write={write_ms}ms"),
        );
    } else {
        logger::debug(
            "pty",
            &format!("pty_write: pid={pid} bytes={nbytes} lock_wait={lock_ms}ms write={write_ms}ms"),
        );
    }
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
        .ok_or_else(|| {
            logger::warn("pty", &format!("pty_read: unknown pid={pid}"));
            "Unavailable pid"
        })?
        .clone();
    let mut buf = vec![0u8; 4096];
    // The read holds the reader lock for as long as it blocks waiting for shell
    // output — which is normal and can be many seconds of idle. We measure it so
    // an export shows exactly how long each read was parked; a write stalling at
    // the same wall-clock as a long read is the signature of runtime starvation.
    let t0 = Instant::now();
    let mut reader = session.reader.lock().await;
    let lock_ms = t0.elapsed().as_millis();
    let t1 = Instant::now();
    let n = reader.read(&mut buf).map_err(|e| {
        logger::error("pty", &format!("pty_read: pid={pid} read failed: {e}"));
        e.to_string()
    })?;
    let read_ms = t1.elapsed().as_millis();
    if n == 0 {
        logger::info("pty", &format!("pty_read: pid={pid} EOF after {read_ms}ms"));
        Err(String::from("EOF"))
    } else {
        buf.truncate(n);
        if lock_ms >= SLOW_MS {
            // a long lock wait (as opposed to a long read) means another task
            // held the reader — unusual, worth flagging.
            logger::warn(
                "pty",
                &format!("pty_read: SLOW lock pid={pid} bytes={n} lock_wait={lock_ms}ms blocked={read_ms}ms"),
            );
        } else {
            logger::trace(
                "pty",
                &format!("pty_read: pid={pid} bytes={n} lock_wait={lock_ms}ms blocked={read_ms}ms"),
            );
        }
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
        .ok_or_else(|| {
            logger::warn("pty", &format!("pty_resize: unknown pid={pid}"));
            "Unavailable pid"
        })?
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
        .map_err(|e| {
            logger::error("pty", &format!("pty_resize: pid={pid} failed: {e}"));
            e.to_string()
        })?;
    logger::debug("pty", &format!("pty_resize: pid={pid} cols={cols} rows={rows}"));
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(pid: u32, state: tauri::State<'_, PtyState>) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or_else(|| {
            logger::warn("pty", &format!("pty_kill: unknown pid={pid}"));
            "Unavailable pid"
        })?
        .clone();
    session
        .child_killer
        .lock()
        .await
        .kill()
        .map_err(|e| {
            logger::error("pty", &format!("pty_kill: pid={pid} failed: {e}"));
            e.to_string()
        })?;
    // drop the session from the live map so it doesn't linger after kill
    state.sessions.write().await.remove(&pid);
    logger::info("pty", &format!("pty_kill: pid={pid} killed and removed"));
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
        .ok_or_else(|| {
            logger::warn("pty", &format!("pty_exitstatus: unknown pid={pid}"));
            "Unavailable pid"
        })?
        .clone();
    let exit_code = session
        .child
        .lock()
        .await
        .wait()
        .map_err(|e| {
            logger::error("pty", &format!("pty_exitstatus: pid={pid} wait failed: {e}"));
            e.to_string()
        })?
        .exit_code();
    logger::info("pty", &format!("pty_exitstatus: pid={pid} exited code={exit_code}"));
    Ok(exit_code)
}
