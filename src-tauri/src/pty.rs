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
//!
//! ## Why a dedicated reader thread per session
//!
//! `std::io::Read::read` on the master fd is a *blocking* syscall, and
//! `portable_pty::Child::wait` likewise blocks on `waitpid`. If we invoke
//! them directly from an `async` tauri command, they park the tokio worker
//! that was assigned to that command. Each live session has TWO such tasks
//! permanently in flight (the JS-side `readLoop` keeps a `pty_read` parked,
//! and `waitForExit` keeps a `pty_exitstatus` parked), so the headroom on a
//! 16-core Mac (16 default workers) is exhausted by ~8 sessions. The 9th
//! shell's first read never gets scheduled — its tab renders blank and stays
//! frozen.
//!
//! Fix:
//!   * `pty_spawn` hands the reader off to a dedicated OS thread which loops
//!     `read()` and pushes chunks through a `tokio::sync::mpsc::channel`.
//!     `pty_read` just `recv().await`s from that channel — no blocking
//!     syscall on the async worker pool.
//!   * `pty_write` only enqueues bytes onto a bounded channel. A dedicated
//!     writer thread per session owns the blocking writer and drains the queue.
//!   * `pty_exitstatus` runs `child.wait()` inside `spawn_blocking`, which
//!     dispatches to tokio's blocking-thread pool (default 512 threads).

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
use tokio::sync::mpsc;

use crate::logger;

/// A blocking call that holds a lock or the reader for longer than this many
/// milliseconds is suspicious — log it at WARN so it stands out in an export.
/// The "hang and can't type" symptom should surface here: if `pty_read` blocks
/// for seconds while the async runtime can't service `pty_write`, that gap is
/// exactly what proves the starvation theory.
const SLOW_MS: u128 = 250;

/// Per-read chunk size on the master fd. Matches the previous in-place read
/// buffer so behavior on the wire is unchanged; the reader thread copies into
/// a fresh Vec for each chunk so the channel hands off ownership cleanly.
const READ_CHUNK: usize = 4096;

/// Channel capacity between the per-session reader thread and `pty_read`.
/// Bounded so a runaway shell can't balloon memory if the frontend stops
/// consuming. 64 chunks ≈ 256KB of buffered output — plenty for normal hiccups
/// without becoming a leak vector.
const READ_CHANNEL_CAP: usize = 64;

/// Bounded input queue between `pty_write` and the session's writer thread.
/// Keyboard input is normally one byte and a paste arrives as one message, so
/// this leaves burst headroom without allowing unbounded growth on a stuck PTY.
const WRITE_CHANNEL_CAP: usize = 64;

/// Events emitted by the per-session reader thread into the mpsc channel.
enum ReadEvent {
    Data(Vec<u8>),
    Eof,
    Err(String),
}

#[derive(Default)]
pub struct PtyState {
    /// Fallback id source for the (rare) case where portable-pty cannot give
    /// us a real OS pid. Keeps every session keyable even on broken platforms.
    fallback_id: AtomicU32,
    sessions: RwLock<BTreeMap<u32, Arc<Session>>>,
}

struct Session {
    pair: Mutex<PtyPair>,
    // child is consumed by a sync waitpid call inside `spawn_blocking`. A
    // std::sync::Mutex is what spawn_blocking expects (no .await across the
    // guard); the async tokio Mutex can't help us here because `Child::wait`
    // is sync and would block the worker if held by an async task.
    child: std::sync::Mutex<Box<dyn Child + Send + Sync>>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    writer_tx: mpsc::Sender<Vec<u8>>,
    /// Receiver side of the per-session reader thread's mpsc channel. Wrapped
    /// in an async Mutex because tokio's `Receiver::recv` requires `&mut self`
    /// and `pty_read` is concurrent in principle — though in practice only one
    /// frontend `readLoop` consumes per session.
    rx: Mutex<mpsc::Receiver<ReadEvent>>,
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
    // AppImage's runtime sets ARGV0 to the .AppImage filename. zsh re-injects
    // ARGV0 as argv[0] of every command it spawns, so a rustup proxy shim
    // (~/.cargo/bin/cargo -> rustup) sees the AppImage name instead of "cargo"
    // and dies with `unknown proxy name`. Strip it from the shell's env so
    // child processes get a clean argv[0]. Harmless outside AppImage (unset).
    cmd.env_remove("ARGV0");
    // Marker so hooks/scripts can tell they're running inside yterminal. The
    // agent-status hooks we install into ~/.claude/settings.json emit their
    // OSC 777 status sequence only when this is set, so the hooks are inert in
    // any other terminal (see main.rs install_claude_hooks).
    cmd.env("YTERMINAL", "1");
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

    let (writer_tx, writer_rx) = mpsc::channel::<Vec<u8>>(WRITE_CHANNEL_CAP);
    let writer_thread_name = format!("pty-writer-{id}");
    if let Err(e) = std::thread::Builder::new()
        .name(writer_thread_name.clone())
        .spawn(move || match writer_loop(id, writer, writer_rx) {
            Ok(()) => logger::info("pty", &format!("writer thread: pid={id} closed, exiting")),
            Err(message) => logger::error("pty", &message),
        })
    {
        logger::error(
            "pty",
            &format!("pty_spawn: failed to spawn writer thread {writer_thread_name}: {e}"),
        );
        return Err(format!("spawn writer thread: {e}"));
    }

    let (tx, rx) = mpsc::channel::<ReadEvent>(READ_CHANNEL_CAP);
    // Reader thread owns the blocking reader for the session's lifetime.
    // When the session is dropped (pty_kill or shell exit), the Receiver is
    // dropped — the next `tx.blocking_send` returns Err and the thread exits
    // on its own. EOF on the master fd is similarly self-terminating.
    let thread_name = format!("pty-reader-{id}");
    if let Err(e) = std::thread::Builder::new()
        .name(thread_name.clone())
        .spawn(move || reader_thread_main(id, reader, tx))
    {
        logger::error(
            "pty",
            &format!("pty_spawn: failed to spawn reader thread {thread_name}: {e}"),
        );
        return Err(format!("spawn reader thread: {e}"));
    }

    let session = Arc::new(Session {
        pair: Mutex::new(pair),
        child: std::sync::Mutex::new(child),
        child_killer: Mutex::new(child_killer),
        writer_tx,
        rx: Mutex::new(rx),
    });
    state.sessions.write().await.insert(id, session);
    let count = state.sessions.read().await.len();
    logger::info(
        "pty",
        &format!("pty_spawn: session ready pid={id} live_sessions={count}"),
    );
    Ok(id)
}

/// Drain frontend input in order on a dedicated OS thread. `blocking_recv` is
/// intentional here: this function never runs on Tauri's async worker pool.
fn writer_loop<W: std::io::Write>(
    pid: u32,
    mut writer: W,
    mut rx: mpsc::Receiver<Vec<u8>>,
) -> Result<(), String> {
    while let Some(data) = rx.blocking_recv() {
        let write_t = Instant::now();
        writer
            .write_all(&data)
            .map_err(|e| format!("pty writer: pid={pid} write failed: {e}"))?;
        let write_ms = write_t.elapsed().as_millis();
        if write_ms >= SLOW_MS {
            logger::warn(
                "pty",
                &format!(
                    "pty writer: SLOW pid={pid} bytes={} write={write_ms}ms",
                    data.len()
                ),
            );
        }
    }
    Ok(())
}

/// Per-session blocking read loop. Lives on its own OS thread for the entire
/// life of the session — that's what keeps every blocking `read()` off the
/// async worker pool, no matter how many shells are open.
fn reader_thread_main(
    pid: u32,
    mut reader: Box<dyn std::io::Read + Send>,
    tx: mpsc::Sender<ReadEvent>,
) {
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                let _ = tx.blocking_send(ReadEvent::Eof);
                logger::info("pty", &format!("reader thread: pid={pid} EOF, exiting"));
                return;
            }
            Ok(n) => {
                let chunk = buf[..n].to_vec();
                if tx.blocking_send(ReadEvent::Data(chunk)).is_err() {
                    // receiver dropped — session is gone, stop reading
                    logger::info(
                        "pty",
                        &format!("reader thread: pid={pid} receiver dropped, exiting"),
                    );
                    return;
                }
            }
            Err(e) => {
                let msg = e.to_string();
                logger::error("pty", &format!("reader thread: pid={pid} read failed: {msg}"));
                let _ = tx.blocking_send(ReadEvent::Err(msg));
                return;
            }
        }
    }
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
    // Queueing is async and bounded. The session's dedicated writer thread owns
    // the blocking write_all call, so a full PTY can never park this worker.
    let enqueue_t = Instant::now();
    session
        .writer_tx
        .send(data.into_bytes())
        .await
        .map_err(|_| {
            let message = format!("pty_write: writer queue closed pid={pid}");
            logger::error("pty", &message);
            message
        })?;
    let enqueue_ms = enqueue_t.elapsed().as_millis();
    if enqueue_ms >= SLOW_MS {
        logger::warn(
            "pty",
            &format!("pty_write: SLOW pid={pid} bytes={nbytes} enqueue={enqueue_ms}ms"),
        );
    }
    Ok(())
}

/// Long-poll: awaits a chunk from the per-session reader thread's channel.
/// No blocking syscalls on the async worker — that's the whole point of the
/// channel hand-off. EOF is reported as the literal string "EOF" in the
/// rejection, same wire shape `tauri-plugin-pty` used and the frontend's
/// exitstatus path keys off.
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
    let t0 = Instant::now();
    let mut rx = session.rx.lock().await;
    let lock_ms = t0.elapsed().as_millis();
    let t1 = Instant::now();
    let event = match rx.recv().await {
        Some(ev) => ev,
        None => {
            // sender dropped without sending Eof — treat as EOF for the
            // frontend so the readLoop unwinds and waitForExit takes over.
            let read_ms = t1.elapsed().as_millis();
            logger::info(
                "pty",
                &format!("pty_read: pid={pid} channel closed after {read_ms}ms"),
            );
            return Err(String::from("EOF"));
        }
    };
    let read_ms = t1.elapsed().as_millis();
    match event {
        ReadEvent::Data(buf) => {
            let n = buf.len();
            if lock_ms >= SLOW_MS {
                // long lock wait now means another `pty_read` was already
                // parked on this session's receiver — unusual, worth flagging.
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
        ReadEvent::Eof => {
            logger::info("pty", &format!("pty_read: pid={pid} EOF after {read_ms}ms"));
            Err(String::from("EOF"))
        }
        ReadEvent::Err(e) => {
            logger::error("pty", &format!("pty_read: pid={pid} read failed: {e}"));
            Err(e)
        }
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
    // Drop the session from the live map so it doesn't linger after kill.
    // The reader thread will exit on its own as soon as its `blocking_send`
    // returns Err (receiver dropped) or read() returns EOF (slave closed).
    state.sessions.write().await.remove(&pid);
    logger::info("pty", &format!("pty_kill: pid={pid} killed and removed"));
    Ok(())
}

/// Long-poll: blocks until the child exits, returns the exit code.
/// `child.wait()` is a sync `waitpid` so we hand it off to the blocking pool
/// — otherwise this single call would park an async worker for the entire
/// life of the shell, and 9 shells would exhaust a default tokio runtime.
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
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut child = session
            .child
            .lock()
            .map_err(|e| format!("child mutex poisoned: {e}"))?;
        child.wait().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking join failed: {e}"))?;
    let exit_code = result
        .map_err(|e| {
            logger::error("pty", &format!("pty_exitstatus: pid={pid} wait failed: {e}"));
            e
        })?
        .exit_code();
    logger::info("pty", &format!("pty_exitstatus: pid={pid} exited code={exit_code}"));
    Ok(exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Write};
    use std::sync::{Arc, Mutex as StdMutex};

    struct SharedWriter(Arc<StdMutex<Vec<u8>>>);

    impl Write for SharedWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("expected write failure"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn writer_loop_preserves_message_order_and_exits_when_closed() {
        let output = Arc::new(StdMutex::new(Vec::new()));
        let writer = SharedWriter(output.clone());
        let (tx, rx) = mpsc::channel(4);
        tx.blocking_send(b"ab".to_vec()).unwrap();
        tx.blocking_send(b"cd".to_vec()).unwrap();
        drop(tx);

        assert!(writer_loop(7, writer, rx).is_ok());
        assert_eq!(&*output.lock().unwrap(), b"abcd");
    }

    #[test]
    fn writer_loop_stops_on_write_error() {
        let (tx, rx) = mpsc::channel(1);
        tx.blocking_send(b"x".to_vec()).unwrap();
        drop(tx);

        let err = writer_loop(8, FailingWriter, rx).unwrap_err();
        assert!(err.contains("expected write failure"));
    }
}
