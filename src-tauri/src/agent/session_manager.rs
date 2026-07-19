use super::host_services;
use super::osc::{OscParser, OscUpdate};
use super::repository::{AgentRepository, PersistedOutputChunk};
use crate::remote_protocol::{
    EventBody, EventFrame, RemoteError, SessionInfo, SessionState, WireMessage,
    MAX_CHECKPOINT_CHUNK_BYTES,
};
use crate::workspace::{PaneAgentSummary, WorkspaceDocument, WorkspaceOperation};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtyPair, PtySize};
use serde_bytes::ByteBuf;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::ffi::OsString;
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::broadcast;
use tokio::sync::{mpsc, Mutex, RwLock};
use uuid::Uuid;

const READ_CHUNK: usize = 4096;
const READ_CHANNEL_CAP: usize = 64;
const WRITE_CHANNEL_CAP: usize = 64;
const MAX_IN_MEMORY_JOURNAL_BYTES: usize = 8 * 1024 * 1024;
const SUBSCRIBER_SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const OSC_QUEUE_CAPACITY: usize = 256;

#[derive(Debug, Clone)]
struct OutputChunk {
    start_seq: u64,
    data: Vec<u8>,
}

impl OutputChunk {
    fn end_seq(&self) -> u64 {
        self.start_seq.saturating_add(self.data.len() as u64)
    }
}

#[derive(Debug, Clone)]
struct Checkpoint {
    through_seq: u64,
    ansi: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ReplayPlan {
    reset: bool,
    base_seq: u64,
    include_checkpoint: bool,
    history_truncated: bool,
}

fn replay_plan(
    after_seq: Option<u64>,
    journal_start: u64,
    head_seq: u64,
    checkpoint_seq: Option<u64>,
) -> ReplayPlan {
    if after_seq
        .map(|seq| seq >= journal_start && seq <= head_seq)
        .unwrap_or(false)
    {
        return ReplayPlan {
            reset: false,
            base_seq: after_seq.unwrap(),
            include_checkpoint: false,
            history_truncated: false,
        };
    }
    if let Some(checkpoint_seq) = checkpoint_seq.filter(|seq| *seq >= journal_start) {
        return ReplayPlan {
            reset: true,
            base_seq: checkpoint_seq,
            include_checkpoint: true,
            history_truncated: false,
        };
    }
    if journal_start > 0 {
        return ReplayPlan {
            reset: true,
            base_seq: journal_start,
            include_checkpoint: false,
            history_truncated: true,
        };
    }
    ReplayPlan {
        // `after_seq=None` means the client has no agent-confirmed renderer
        // state. Its xterm may contain a legacy/offline snapshot, so the agent
        // must authoritatively reset it before replaying from sequence zero.
        reset: true,
        base_seq: 0,
        include_checkpoint: false,
        history_truncated: false,
    }
}

/// Extend the always-contiguous in-memory tail with as much of the persisted
/// journal as can be proven contiguous. A dropped disk-queue chunk stops the
/// extension; attach will then report `history_truncated` rather than replay a
/// stream with a hidden sequence gap.
fn extend_journal_backwards(
    retained: Vec<OutputChunk>,
    persisted: Vec<PersistedOutputChunk>,
    head_seq: u64,
) -> Vec<OutputChunk> {
    let mut result = VecDeque::from(retained);
    let mut start = result
        .front()
        .map(|chunk| chunk.start_seq)
        .unwrap_or(head_seq);
    for chunk in persisted.into_iter().rev() {
        if chunk.start_seq >= start {
            continue;
        }
        let end = chunk.start_seq.saturating_add(chunk.data.len() as u64);
        if end < start {
            // Because rows are ordered, every earlier chunk ends even farther
            // from the retained tail. The missing range is a real disk gap.
            break;
        }
        let prefix_len = start.saturating_sub(chunk.start_seq) as usize;
        if prefix_len == 0 || prefix_len > chunk.data.len() {
            continue;
        }
        result.push_front(OutputChunk {
            start_seq: chunk.start_seq,
            data: chunk.data[..prefix_len].to_vec(),
        });
        start = chunk.start_seq;
    }
    result.into_iter().collect()
}

struct SessionData {
    state: SessionState,
    exit_code: Option<u32>,
    cols: u16,
    rows: u16,
    head_seq: u64,
    journal: VecDeque<OutputChunk>,
    journal_bytes: usize,
    checkpoint: Option<Checkpoint>,
    subscribers: HashMap<String, mpsc::Sender<WireMessage>>,
    osc: OscParser,
    osc_cwd_seen: bool,
    reader_done: bool,
    input_line: String,
    recent_submits: VecDeque<String>,
    detected_agent_pid: Option<u32>,
    detected_agent: Option<PaneAgentSummary>,
}

struct ManagedSession {
    id: String,
    workspace_id: String,
    pane_id: String,
    cwd: Option<String>,
    pid: Option<u32>,
    pair: Mutex<PtyPair>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    writer_tx: mpsc::Sender<Vec<u8>>,
    data: Mutex<SessionData>,
}

struct SessionManagerInner {
    repository: Arc<AgentRepository>,
    sessions: RwLock<HashMap<String, Arc<ManagedSession>>>,
    workspace_updates: broadcast::Sender<WorkspaceDocument>,
    osc_tx: std_mpsc::SyncSender<OscWork>,
}

struct OscWork {
    workspace_id: String,
    pane_id: String,
    updates: Vec<OscUpdate>,
}

struct ObservedHostState {
    detected_pid: Option<u32>,
    agent: Option<PaneAgentSummary>,
}

struct HostObservationInput {
    workspace_id: String,
    pane_id: String,
    pid: u32,
    recent_submits: Vec<String>,
    cached_pid: Option<u32>,
    cached_agent: Option<PaneAgentSummary>,
    osc_cwd_seen: bool,
}

#[derive(Clone)]
pub struct SessionManager {
    inner: Arc<SessionManagerInner>,
}

pub struct SpawnRequest {
    pub workspace_id: String,
    pub pane_id: String,
    pub file: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
}

enum ReadEvent {
    Data(Vec<u8>),
    Eof,
    Error(String),
}

impl SessionManager {
    pub fn new(repository: Arc<AgentRepository>) -> Self {
        let (workspace_updates, _) = broadcast::channel(256);
        let (osc_tx, osc_rx) = std_mpsc::sync_channel::<OscWork>(OSC_QUEUE_CAPACITY);
        let osc_repository = repository.clone();
        let osc_workspace_updates = workspace_updates.clone();
        std::thread::Builder::new()
            .name("yterminal-agent-osc".into())
            .spawn(move || {
                while let Ok(work) = osc_rx.recv() {
                    for update in work.updates {
                        if let Some(workspace) = apply_osc_update(
                            &osc_repository,
                            &work.workspace_id,
                            &work.pane_id,
                            update,
                        ) {
                            let _ = osc_workspace_updates.send(workspace);
                        }
                    }
                }
            })
            .expect("spawn yterminal agent OSC worker");
        let manager = Self {
            inner: Arc::new(SessionManagerInner {
                repository,
                sessions: RwLock::new(HashMap::new()),
                workspace_updates,
                osc_tx,
            }),
        };
        manager.start_host_snapshot_loop();
        manager
    }

    fn start_host_snapshot_loop(&self) {
        let manager = self.clone();
        tokio::spawn(async move {
            let period = std::time::Duration::from_secs(15);
            let mut interval =
                tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            loop {
                interval.tick().await;
                manager.snapshot_host_state().await;
            }
        });
    }

    pub fn subscribe_workspace_updates(&self) -> broadcast::Receiver<WorkspaceDocument> {
        self.inner.workspace_updates.subscribe()
    }

    pub async fn spawn(&self, req: SpawnRequest) -> Result<(String, Option<u32>), RemoteError> {
        if req.cols == 0 || req.rows == 0 {
            return Err(RemoteError::new(
                "invalid_size",
                "PTY size must be non-zero",
            ));
        }
        // Reopening the GUI calls spawn for every visible pane because the
        // legacy frontend does not yet persist agent session UUIDs. Treat
        // (workspace,pane) as an idempotency key while a session is live so
        // the call attaches to the daemon-owned process instead of creating a
        // duplicate shell.
        let existing = self
            .inner
            .sessions
            .read()
            .await
            .values()
            .filter(|session| {
                session.workspace_id == req.workspace_id && session.pane_id == req.pane_id
            })
            .cloned()
            .collect::<Vec<_>>();
        for session in existing {
            if session.data.lock().await.state == SessionState::Running {
                return Ok((session.id.clone(), session.pid));
            }
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: req.rows,
                cols: req.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| RemoteError::new("open_pty_failed", e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| RemoteError::new("open_writer_failed", e.to_string()))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| RemoteError::new("open_reader_failed", e.to_string()))?;

        let shell = if req.file.trim().is_empty() {
            default_shell()
        } else {
            req.file
        };
        let spawn_cwd = req
            .cwd
            .clone()
            .or_else(|| std::env::var_os("HOME").map(|home| home.to_string_lossy().into_owned()));
        let mut command = CommandBuilder::new(shell);
        command.args(req.args);
        if let Some(cwd) = &spawn_cwd {
            command.cwd(OsString::from(cwd));
        }
        for (key, value) in &req.env {
            command.env(OsString::from(key), OsString::from(value));
        }
        command.env_remove("ARGV0");
        command.env("YTERMINAL", "1");
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| RemoteError::new("spawn_failed", e.to_string()))?;
        let pid = child.process_id();
        let killer = child.clone_killer();
        let child = Arc::new(StdMutex::new(child));
        let id = Uuid::new_v4().to_string();

        let (writer_tx, writer_rx) = mpsc::channel(WRITE_CHANNEL_CAP);
        let writer_name = format!("agent-pty-writer-{id}");
        std::thread::Builder::new()
            .name(writer_name)
            .spawn(move || writer_loop(writer, writer_rx))
            .map_err(|e| RemoteError::new("writer_thread_failed", e.to_string()))?;

        let (read_tx, mut read_rx) = mpsc::channel(READ_CHANNEL_CAP);
        let reader_name = format!("agent-pty-reader-{id}");
        std::thread::Builder::new()
            .name(reader_name)
            .spawn(move || reader_loop(reader, read_tx))
            .map_err(|e| RemoteError::new("reader_thread_failed", e.to_string()))?;

        let session = Arc::new(ManagedSession {
            id: id.clone(),
            workspace_id: req.workspace_id.clone(),
            pane_id: req.pane_id.clone(),
            cwd: spawn_cwd.clone(),
            pid,
            pair: Mutex::new(pair),
            killer: Mutex::new(killer),
            writer_tx,
            data: Mutex::new(SessionData {
                state: SessionState::Running,
                exit_code: None,
                cols: req.cols,
                rows: req.rows,
                head_seq: 0,
                journal: VecDeque::new(),
                journal_bytes: 0,
                checkpoint: None,
                subscribers: HashMap::new(),
                osc: OscParser::default(),
                osc_cwd_seen: false,
                reader_done: false,
                input_line: String::new(),
                recent_submits: VecDeque::new(),
                detected_agent_pid: None,
                detected_agent: None,
            }),
        });

        self.inner
            .repository
            .record_session_spawn(
                &id,
                &req.workspace_id,
                &req.pane_id,
                pid,
                spawn_cwd.as_deref(),
                req.cols,
                req.rows,
            )
            .map_err(|e| RemoteError::new("database_failed", e))?;

        // Hot-restart inheritance: a pane respawned after the daemon restarted
        // gets a brand-new session id with an empty journal, so a fresh attach
        // (reopened GUI, remote reconnect, CLI) would see no scrollback. Seed
        // this session with the predecessor's persisted checkpoint so an
        // `after_seq=None` replay renders the prior screen, then sequences live
        // output after it. Best-effort: a read failure just yields empty
        // scrollback rather than blocking the spawn. Runs before the output
        // consumer task starts, so head_seq cannot have advanced yet.
        match self
            .inner
            .repository
            .load_pane_inheritance(req.workspace_id.clone(), req.pane_id.clone(), id.clone())
            .await
        {
            Ok(Some(inherited)) if !inherited.ansi.is_empty() => {
                let mut data = session.data.lock().await;
                if data.head_seq == 0 && data.journal.is_empty() {
                    data.head_seq = inherited.through_seq;
                    // Persist a checkpoint for THIS session at the inherited
                    // base so a second restart before any new checkpoint still
                    // inherits the same screen.
                    if let Err(error) = self
                        .inner
                        .repository
                        .save_checkpoint(id.clone(), inherited.through_seq, inherited.ansi.clone())
                        .await
                    {
                        eprintln!(
                            "yterminal-agent inherit checkpoint persist failed session={id}: {error}"
                        );
                    }
                    data.checkpoint = Some(Checkpoint {
                        through_seq: inherited.through_seq,
                        ansi: inherited.ansi,
                    });
                }
            }
            Ok(_) => {}
            Err(error) => {
                eprintln!(
                    "yterminal-agent inherit checkpoint read failed pane={}: {error}",
                    req.pane_id
                );
            }
        }

        self.inner
            .sessions
            .write()
            .await
            .insert(id.clone(), session.clone());

        let output_session = session.clone();
        let repository = self.inner.repository.clone();
        let osc_tx = self.inner.osc_tx.clone();
        tokio::spawn(async move {
            while let Some(event) = read_rx.recv().await {
                match event {
                    ReadEvent::Data(bytes) => {
                        let (start_seq, osc_updates, slow_subscribers) = {
                            let mut data = output_session.data.lock().await;
                            let osc_updates = data.osc.push(&bytes);
                            if osc_updates
                                .iter()
                                .any(|update| matches!(update, OscUpdate::Cwd(_)))
                            {
                                data.osc_cwd_seen = true;
                            }
                            let start_seq = data.head_seq;
                            data.head_seq = data.head_seq.saturating_add(bytes.len() as u64);
                            data.journal.push_back(OutputChunk {
                                start_seq,
                                data: bytes.clone(),
                            });
                            data.journal_bytes = data.journal_bytes.saturating_add(bytes.len());
                            while data.journal_bytes > MAX_IN_MEMORY_JOURNAL_BYTES {
                                let Some(removed) = data.journal.pop_front() else {
                                    break;
                                };
                                data.journal_bytes =
                                    data.journal_bytes.saturating_sub(removed.data.len());
                            }
                            let message = WireMessage::Event(EventFrame {
                                body: EventBody::Output {
                                    session_id: output_session.id.clone(),
                                    start_seq,
                                    bytes: ByteBuf::from(bytes.clone()),
                                },
                            });
                            // A client that cannot keep up is detached from
                            // this live stream. It can reconnect using its last
                            // acknowledged sequence and replay from the journal.
                            let mut slow_subscribers = Vec::new();
                            data.subscribers.retain(|_, subscriber| {
                                match subscriber.try_send(message.clone()) {
                                    Ok(()) => true,
                                    Err(mpsc::error::TrySendError::Full(_)) => {
                                        slow_subscribers.push(subscriber.clone());
                                        false
                                    }
                                    Err(mpsc::error::TrySendError::Closed(_)) => false,
                                }
                            });
                            (start_seq, osc_updates, slow_subscribers)
                        };
                        let _ = repository.enqueue_output(
                            output_session.id.clone(),
                            start_seq,
                            bytes.clone(),
                        );
                        for subscriber in slow_subscribers {
                            let session_id = output_session.id.clone();
                            tokio::spawn(async move {
                                let _ = tokio::time::timeout(
                                    SUBSCRIBER_SEND_TIMEOUT,
                                    subscriber.send(WireMessage::Event(EventFrame {
                                        body: EventBody::Warning {
                                            code: "slow_client_detached".into(),
                                            message: format!(
                                                "terminal stream {session_id} fell behind; reconnecting"
                                            ),
                                        },
                                    })),
                                )
                                .await;
                            });
                        }
                        if !osc_updates.is_empty() {
                            let _ = osc_tx.try_send(OscWork {
                                workspace_id: output_session.workspace_id.clone(),
                                pane_id: output_session.pane_id.clone(),
                                updates: osc_updates,
                            });
                        }
                    }
                    ReadEvent::Eof => {
                        output_session.data.lock().await.reader_done = true;
                        break;
                    }
                    ReadEvent::Error(message) => {
                        let warning = WireMessage::Event(EventFrame {
                            body: EventBody::Warning {
                                code: "pty_read_failed".into(),
                                message,
                            },
                        });
                        output_session
                            .data
                            .lock()
                            .await
                            .subscribers
                            .retain(|_, subscriber| subscriber.try_send(warning.clone()).is_ok());
                        output_session.data.lock().await.reader_done = true;
                        break;
                    }
                }
            }
        });

        let wait_session = session;
        let repository = self.inner.repository.clone();
        tokio::spawn(async move {
            let waited = tokio::task::spawn_blocking(move || {
                let mut child = child.lock().map_err(|e| e.to_string())?;
                child.wait().map_err(|e| e.to_string())
            })
            .await;
            let exit_code = match waited {
                Ok(Ok(status)) => status.exit_code(),
                Ok(Err(message)) => {
                    eprintln!("yterminal-agent wait failed: {message}");
                    1
                }
                Err(message) => {
                    eprintln!("yterminal-agent wait task failed: {message}");
                    1
                }
            };
            let event = WireMessage::Event(EventFrame {
                body: EventBody::Exited {
                    session_id: wait_session.id.clone(),
                    exit_code,
                },
            });
            {
                let mut data = wait_session.data.lock().await;
                if data.state != SessionState::Running {
                    return;
                }
                data.state = SessionState::Exited;
                data.exit_code = Some(exit_code);
                data.subscribers
                    .retain(|_, subscriber| subscriber.try_send(event.clone()).is_ok());
            }
            let _ = repository.mark_exit(&wait_session.id, exit_code);
        });

        Ok((id, pid))
    }

    /// Keep cwd and coding-agent metadata authoritative even while no GUI is
    /// attached. OSC updates remain the fast path; this periodic process-tree
    /// snapshot covers shells/tools that do not emit those sequences.
    async fn snapshot_host_state(&self) {
        let sessions = self
            .inner
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for session in sessions {
            let (pid, recent_submits, cached_pid, cached_agent, osc_cwd_seen) = {
                let data = session.data.lock().await;
                if data.state != SessionState::Running {
                    continue;
                }
                let Some(pid) = session.pid else { continue };
                (
                    pid,
                    data.recent_submits.iter().cloned().collect::<Vec<_>>(),
                    data.detected_agent_pid,
                    data.detected_agent.clone(),
                    data.osc_cwd_seen,
                )
            };
            let repository = self.inner.repository.clone();
            let input = HostObservationInput {
                workspace_id: session.workspace_id.clone(),
                pane_id: session.pane_id.clone(),
                pid,
                recent_submits,
                cached_pid,
                cached_agent,
                osc_cwd_seen,
            };
            let observed =
                tokio::task::spawn_blocking(move || observe_host_state(&repository, input)).await;
            let Ok(Ok((observed, workspace))) = observed else {
                continue;
            };
            {
                let mut data = session.data.lock().await;
                if data.state != SessionState::Running {
                    continue;
                }
                data.detected_agent_pid = observed.detected_pid;
                data.detected_agent = observed.agent;
            }
            if let Some(workspace) = workspace {
                let _ = self.inner.workspace_updates.send(workspace);
            }
        }
    }

    pub async fn list(&self) -> Vec<SessionInfo> {
        let sessions = self
            .inner
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut result = Vec::with_capacity(sessions.len());
        for session in sessions {
            let data = session.data.lock().await;
            result.push(SessionInfo {
                session_id: session.id.clone(),
                pane_id: session.pane_id.clone(),
                workspace_id: session.workspace_id.clone(),
                state: data.state,
                pid: session.pid,
                cwd: session.cwd.clone(),
                cols: data.cols,
                rows: data.rows,
                head_seq: data.head_seq,
                exit_code: data.exit_code,
            });
        }
        result
    }

    pub async fn running_count(&self) -> u32 {
        let sessions = self
            .inner
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut count = 0;
        for session in sessions {
            if session.data.lock().await.state == SessionState::Running {
                count += 1;
            }
        }
        count
    }

    async fn get(&self, session_id: &str) -> Result<Arc<ManagedSession>, RemoteError> {
        self.inner
            .sessions
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| RemoteError::new("session_not_found", session_id))
    }

    pub async fn workspace_id(&self, session_id: &str) -> Result<String, RemoteError> {
        Ok(self.get(session_id).await?.workspace_id.clone())
    }

    pub async fn pid(&self, session_id: &str) -> Result<u32, RemoteError> {
        self.get(session_id)
            .await?
            .pid
            .ok_or_else(|| RemoteError::new("session_pid_unavailable", session_id))
    }

    pub async fn input(&self, session_id: &str, bytes: Vec<u8>) -> Result<(), RemoteError> {
        let session = self.get(session_id).await?;
        {
            let mut data = session.data.lock().await;
            if data.state != SessionState::Running {
                return Err(RemoteError::new("session_exited", session_id));
            }
            record_input(&mut data, &bytes);
        }
        session
            .writer_tx
            .send(bytes)
            .await
            .map_err(|_| RemoteError::new("pty_writer_closed", session_id))
    }

    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), RemoteError> {
        if cols == 0 || rows == 0 {
            return Err(RemoteError::new(
                "invalid_size",
                "PTY size must be non-zero",
            ));
        }
        let session = self.get(session_id).await?;
        {
            let data = session.data.lock().await;
            if data.cols == cols && data.rows == rows {
                return Ok(());
            }
        }
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
            .map_err(|e| RemoteError::new("resize_failed", e.to_string()))?;
        let event = WireMessage::Event(EventFrame {
            body: EventBody::SizeChanged {
                session_id: session.id.clone(),
                cols,
                rows,
            },
        });
        {
            let mut data = session.data.lock().await;
            data.cols = cols;
            data.rows = rows;
            data.subscribers
                .retain(|_, subscriber| subscriber.try_send(event.clone()).is_ok());
        }
        Ok(())
    }

    pub async fn kill(&self, session_id: &str) -> Result<(), RemoteError> {
        let session = self.get(session_id).await?;
        let result = session
            .killer
            .lock()
            .await
            .kill()
            .map_err(|e| RemoteError::new("kill_failed", e.to_string()));
        result
    }

    pub async fn terminate_workspace(&self, workspace_id: &str) -> Vec<String> {
        let sessions = self
            .inner
            .sessions
            .read()
            .await
            .values()
            .filter(|session| session.workspace_id == workspace_id)
            .cloned()
            .collect::<Vec<_>>();
        self.terminate_sessions(sessions).await
    }

    pub async fn terminate_panes(&self, workspace_id: &str, pane_ids: &[String]) -> Vec<String> {
        let pane_ids = pane_ids
            .iter()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>();
        let sessions = self
            .inner
            .sessions
            .read()
            .await
            .values()
            .filter(|session| {
                session.workspace_id == workspace_id && pane_ids.contains(session.pane_id.as_str())
            })
            .cloned()
            .collect::<Vec<_>>();
        self.terminate_sessions(sessions).await
    }

    async fn terminate_sessions(&self, sessions: Vec<Arc<ManagedSession>>) -> Vec<String> {
        for session in &sessions {
            if session.data.lock().await.state == SessionState::Running {
                let _ = session.killer.lock().await.kill();
            }
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let mut finished = true;
            for session in &sessions {
                let data = session.data.lock().await;
                if data.state == SessionState::Running || !data.reader_done {
                    finished = false;
                    break;
                }
            }
            if finished || tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let ids = sessions
            .iter()
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        let mut live = self.inner.sessions.write().await;
        for id in &ids {
            live.remove(id);
        }
        ids
    }

    pub async fn attach(
        &self,
        client_id: &str,
        session_id: &str,
        after_seq: Option<u64>,
        outgoing: mpsc::Sender<WireMessage>,
    ) -> Result<(), RemoteError> {
        let session = self.get(session_id).await?;
        // Holding this lock while enqueueing the finite replay makes replay and
        // live subscription atomic. Each bounded send has a deadline so a
        // client that stops reading cannot freeze the PTY indefinitely.
        let mut data = session.data.lock().await;
        let memory_journal = data.journal.iter().cloned().collect::<Vec<_>>();
        let memory_start = data
            .journal
            .front()
            .map(|chunk| chunk.start_seq)
            .unwrap_or(data.head_seq);
        let checkpoint_seq = data
            .checkpoint
            .as_ref()
            .map(|checkpoint| checkpoint.through_seq);
        let provisional = replay_plan(after_seq, memory_start, data.head_seq, checkpoint_seq);
        let replay_journal = if provisional.history_truncated {
            match self
                .inner
                .repository
                .load_output_chunks(session.id.clone())
                .await
            {
                Ok(persisted) => extend_journal_backwards(memory_journal, persisted, data.head_seq),
                Err(error) => {
                    eprintln!(
                        "yterminal-agent journal replay read failed session={}: {error}",
                        session.id
                    );
                    memory_journal
                }
            }
        } else {
            memory_journal
        };
        let journal_start = replay_journal
            .first()
            .map(|chunk| chunk.start_seq)
            .unwrap_or(data.head_seq);
        let plan = replay_plan(after_seq, journal_start, data.head_seq, checkpoint_seq);
        if plan.history_truncated {
            send_to_client(
                &outgoing,
                WireMessage::Event(EventFrame {
                    body: EventBody::Warning {
                        code: "history_truncated".into(),
                        message: format!(
                            "terminal history before sequence {} is unavailable; replaying the retained tail",
                            plan.base_seq
                        ),
                    },
                }),
                client_id,
            )
            .await?;
        }
        send_to_client(
            &outgoing,
            WireMessage::Event(EventFrame {
                body: EventBody::ReplayBegin {
                    session_id: session.id.clone(),
                    reset: plan.reset,
                    base_seq: plan.base_seq,
                    head_seq: data.head_seq,
                },
            }),
            client_id,
        )
        .await?;
        if plan.include_checkpoint {
            if let Some(checkpoint) = &data.checkpoint {
                for chunk in checkpoint.ansi.chunks(MAX_CHECKPOINT_CHUNK_BYTES) {
                    send_to_client(
                        &outgoing,
                        WireMessage::Event(EventFrame {
                            body: EventBody::CheckpointChunk {
                                session_id: session.id.clone(),
                                bytes: ByteBuf::from(chunk.to_vec()),
                            },
                        }),
                        client_id,
                    )
                    .await?;
                }
            }
        }
        for chunk in &replay_journal {
            if chunk.end_seq() <= plan.base_seq {
                continue;
            }
            let offset = plan.base_seq.saturating_sub(chunk.start_seq) as usize;
            let bytes = chunk.data[offset.min(chunk.data.len())..].to_vec();
            if bytes.is_empty() {
                continue;
            }
            send_to_client(
                &outgoing,
                WireMessage::Event(EventFrame {
                    body: EventBody::Output {
                        session_id: session.id.clone(),
                        start_seq: chunk.start_seq + offset as u64,
                        bytes: ByteBuf::from(bytes),
                    },
                }),
                client_id,
            )
            .await?;
        }
        send_to_client(
            &outgoing,
            WireMessage::Event(EventFrame {
                body: EventBody::ReplayEnd {
                    session_id: session.id.clone(),
                    next_seq: data.head_seq,
                },
            }),
            client_id,
        )
        .await?;
        send_to_client(
            &outgoing,
            WireMessage::Event(EventFrame {
                body: EventBody::SizeChanged {
                    session_id: session.id.clone(),
                    cols: data.cols,
                    rows: data.rows,
                },
            }),
            client_id,
        )
        .await?;
        if data.state == SessionState::Exited {
            send_to_client(
                &outgoing,
                WireMessage::Event(EventFrame {
                    body: EventBody::Exited {
                        session_id: session.id.clone(),
                        exit_code: data.exit_code.unwrap_or(1),
                    },
                }),
                client_id,
            )
            .await?;
        }
        data.subscribers.insert(client_id.to_string(), outgoing);
        Ok(())
    }

    pub async fn detach(&self, client_id: &str, session_id: &str) -> Result<(), RemoteError> {
        let session = self.get(session_id).await?;
        session.data.lock().await.subscribers.remove(client_id);
        Ok(())
    }

    pub async fn detach_client(&self, client_id: &str) {
        let sessions = self
            .inner
            .sessions
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for session in sessions {
            session.data.lock().await.subscribers.remove(client_id);
        }
    }

    pub async fn save_checkpoint(
        &self,
        session_id: &str,
        through_seq: u64,
        ansi: Vec<u8>,
    ) -> Result<(), RemoteError> {
        let session = self.get(session_id).await?;
        {
            let mut data = session.data.lock().await;
            let previous = data
                .checkpoint
                .as_ref()
                .map(|checkpoint| checkpoint.through_seq)
                .unwrap_or(0);
            if through_seq < previous || through_seq > data.head_seq {
                return Err(RemoteError::new(
                    "invalid_checkpoint_seq",
                    format!(
                        "checkpoint {through_seq}, previous {previous}, head {}",
                        data.head_seq
                    ),
                ));
            }
            data.checkpoint = Some(Checkpoint {
                through_seq,
                ansi: ansi.clone(),
            });
            while data
                .journal
                .front()
                .map(|chunk| chunk.end_seq() <= through_seq)
                .unwrap_or(false)
            {
                if let Some(removed) = data.journal.pop_front() {
                    data.journal_bytes = data.journal_bytes.saturating_sub(removed.data.len());
                }
            }
        }
        self.inner
            .repository
            .save_checkpoint(session.id.clone(), through_seq, ansi)
            .await
            .map_err(|e| RemoteError::new("checkpoint_database_failed", e))
    }
}

fn observe_host_state(
    repository: &AgentRepository,
    input: HostObservationInput,
) -> Result<(ObservedHostState, Option<WorkspaceDocument>), String> {
    let HostObservationInput {
        workspace_id,
        pane_id,
        pid,
        recent_submits,
        cached_pid,
        cached_agent,
        osc_cwd_seen,
    } = input;
    let process_cwd = host_services::process_cwd(pid).ok();
    let processes = host_services::process_tree(pid);
    let detected = host_services::detect_agent(&processes);
    let current = repository
        .get_workspace(&workspace_id)
        .map_err(|error| error.to_string())?;
    let existing = current.agent_for_pane(&pane_id);
    // OSC 7 describes the interactive shell inside tmux and is more precise
    // than `/proc/<outer-shell>/cwd`. Once observed, retain that authoritative
    // document value instead of periodically overwriting it with the outer PTY.
    let cwd = if osc_cwd_seen {
        current.cwd_for_pane(&pane_id)
    } else {
        process_cwd.clone()
    };
    let agent = detected.as_ref().and_then(|(kind, agent_pid)| {
        let mut agent = if cached_pid == Some(*agent_pid) {
            cached_agent.clone().filter(|agent| agent.kind == *kind)
        } else {
            None
        };
        if agent.is_none() {
            let session_id = host_services::resolve_agent_session(
                kind,
                cwd.as_deref().unwrap_or_default(),
                *agent_pid,
            );
            if let Some(session_id) = session_id {
                let command = recent_submits
                    .iter()
                    .rev()
                    .find(|token| token_matches_kind(token, kind))
                    .cloned()
                    .unwrap_or_else(|| kind.clone());
                agent = Some(PaneAgentSummary {
                    kind: kind.clone(),
                    command,
                    session_id,
                });
            }
        }
        // Preserve a better literal alias captured by an attached GUI when
        // the daemon's process-only fallback knows only the generic command.
        if let (Some(candidate), Some(existing)) = (&mut agent, &existing) {
            if candidate.kind == existing.kind
                && candidate.session_id == existing.session_id
                && candidate.command == candidate.kind
            {
                candidate.command = existing.command.clone();
            }
        }
        agent.or_else(|| existing.clone().filter(|existing| existing.kind == *kind))
    });
    let mut operations = Vec::new();
    if let (Some(cwd), Some(tab_id)) = (
        (!osc_cwd_seen).then_some(process_cwd).flatten(),
        current.tab_id_for_pane(&pane_id),
    ) {
        operations.push(WorkspaceOperation::UpdatePaneCwd {
            tab_id,
            pane_id: pane_id.clone(),
            cwd,
        });
    }
    operations.push(WorkspaceOperation::SetPaneAgent {
        pane_id,
        agent: agent.clone(),
    });
    let workspace = apply_internal_operations(repository, &workspace_id, current, operations);
    Ok((
        ObservedHostState {
            detected_pid: detected.map(|(_, pid)| pid),
            agent,
        },
        workspace,
    ))
}

fn apply_osc_update(
    repository: &AgentRepository,
    workspace_id: &str,
    pane_id: &str,
    update: OscUpdate,
) -> Option<WorkspaceDocument> {
    let current = repository.get_workspace(workspace_id).ok()?;
    let operations = match update {
        OscUpdate::Cwd(cwd) => vec![WorkspaceOperation::UpdatePaneCwd {
            tab_id: current.tab_id_for_pane(pane_id)?,
            pane_id: pane_id.to_string(),
            cwd,
        }],
        OscUpdate::Title(title) => vec![WorkspaceOperation::SetPaneRuntimeTitle {
            pane_id: pane_id.to_string(),
            title: Some(title),
        }],
        OscUpdate::RuntimeStatus(status) => {
            let ended = status.is_none();
            let mut operations = vec![WorkspaceOperation::SetPaneRuntimeStatus {
                pane_id: pane_id.to_string(),
                status,
            }];
            if ended {
                operations.push(WorkspaceOperation::SetPaneAgent {
                    pane_id: pane_id.to_string(),
                    agent: None,
                });
            }
            operations
        }
    };
    apply_internal_operations(repository, workspace_id, current, operations)
}

fn apply_internal_operations(
    repository: &AgentRepository,
    workspace_id: &str,
    mut current: WorkspaceDocument,
    operations: Vec<WorkspaceOperation>,
) -> Option<WorkspaceDocument> {
    let mut changed = false;
    for operation in operations {
        let mut preview = current.clone();
        preview.apply(operation.clone()).ok()?;
        if preview == current {
            continue;
        }
        current = repository
            .apply_workspace_operation_internal(workspace_id, operation)
            .ok()?;
        changed = true;
    }
    changed.then_some(current)
}

fn record_input(data: &mut SessionData, bytes: &[u8]) {
    track_input(&mut data.input_line, &mut data.recent_submits, bytes);
}

fn track_input(input_line: &mut String, recent_submits: &mut VecDeque<String>, bytes: &[u8]) {
    let chunk = String::from_utf8_lossy(bytes)
        .replace("\u{1b}[200~", "")
        .replace("\u{1b}[201~", "");
    let chars = chunk.chars().collect::<Vec<_>>();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        match ch {
            '\r' | '\n' => {
                let token = input_line
                    .split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .to_string();
                input_line.clear();
                if !token.is_empty() {
                    recent_submits.push_back(token);
                    while recent_submits.len() > 16 {
                        recent_submits.pop_front();
                    }
                }
            }
            '\u{7f}' | '\u{8}' => {
                input_line.pop();
            }
            '\u{15}' | '\u{3}' | '\u{4}' => input_line.clear(),
            '\u{1b}' => {
                if matches!(chars.get(index + 1), Some('[' | 'O')) {
                    index += 1;
                    while index + 1 < chars.len() {
                        index += 1;
                        if ('@'..='~').contains(&chars[index]) {
                            break;
                        }
                    }
                }
            }
            control if control.is_control() => {}
            printable => {
                input_line.push(printable);
                if input_line.len() > 64 * 1024 {
                    input_line.clear();
                }
            }
        }
        index += 1;
    }
}

fn token_matches_kind(token: &str, kind: &str) -> bool {
    token
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(token)
        .to_ascii_lowercase()
        .contains(kind)
}

async fn send_to_client(
    outgoing: &mpsc::Sender<WireMessage>,
    message: WireMessage,
    client_id: &str,
) -> Result<(), RemoteError> {
    match tokio::time::timeout(SUBSCRIBER_SEND_TIMEOUT, outgoing.send(message)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(RemoteError::new("client_disconnected", client_id)),
        Err(_) => Err(RemoteError::retryable("client_too_slow", client_id)),
    }
}

fn writer_loop(mut writer: Box<dyn std::io::Write + Send>, mut receiver: mpsc::Receiver<Vec<u8>>) {
    while let Some(data) = receiver.blocking_recv() {
        if let Err(e) = writer.write_all(&data) {
            eprintln!("yterminal-agent pty write failed: {e}");
            break;
        }
    }
}

fn reader_loop(mut reader: Box<dyn std::io::Read + Send>, sender: mpsc::Sender<ReadEvent>) {
    let mut buffer = vec![0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => {
                let _ = sender.blocking_send(ReadEvent::Eof);
                break;
            }
            Ok(read) => {
                if sender
                    .blocking_send(ReadEvent::Data(buffer[..read].to_vec()))
                    .is_err()
                {
                    break;
                }
            }
            Err(error) => {
                let _ = sender.blocking_send(ReadEvent::Error(error.to_string()));
                break;
            }
        }
    }
}

fn default_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.trim().is_empty())
        .or_else(|| {
            ["/bin/zsh", "/bin/bash", "/bin/sh"]
                .into_iter()
                .find(|candidate| std::path::Path::new(candidate).exists())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "/bin/sh".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_uses_only_a_checkpoint_that_connects_to_the_retained_journal() {
        assert_eq!(
            replay_plan(None, 100, 200, Some(100)),
            ReplayPlan {
                reset: true,
                base_seq: 100,
                include_checkpoint: true,
                history_truncated: false,
            }
        );
        assert_eq!(
            replay_plan(None, 150, 200, Some(100)),
            ReplayPlan {
                reset: true,
                base_seq: 150,
                include_checkpoint: false,
                history_truncated: true,
            }
        );
    }

    #[test]
    fn replay_resumes_only_from_a_sequence_still_in_the_journal() {
        assert_eq!(
            replay_plan(Some(175), 150, 200, Some(100)),
            ReplayPlan {
                reset: false,
                base_seq: 175,
                include_checkpoint: false,
                history_truncated: false,
            }
        );
        assert!(replay_plan(Some(201), 150, 200, None).history_truncated);
        assert_eq!(
            replay_plan(None, 0, 10, None),
            ReplayPlan {
                reset: true,
                base_seq: 0,
                include_checkpoint: false,
                history_truncated: false,
            }
        );
    }

    #[test]
    fn persisted_journal_extends_only_the_contiguous_memory_tail() {
        let retained = vec![OutputChunk {
            start_seq: 6,
            data: b"ghi".to_vec(),
        }];
        let complete = extend_journal_backwards(
            retained.clone(),
            vec![
                PersistedOutputChunk {
                    start_seq: 0,
                    data: b"abc".to_vec(),
                },
                PersistedOutputChunk {
                    start_seq: 3,
                    data: b"def".to_vec(),
                },
            ],
            9,
        );
        assert_eq!(complete.first().unwrap().start_seq, 0);
        assert_eq!(
            complete
                .iter()
                .flat_map(|chunk| chunk.data.iter().copied())
                .collect::<Vec<_>>(),
            b"abcdefghi"
        );

        let gap = extend_journal_backwards(
            retained,
            vec![PersistedOutputChunk {
                start_seq: 0,
                data: b"abc".to_vec(),
            }],
            9,
        );
        assert_eq!(gap.first().unwrap().start_seq, 6);
    }

    #[test]
    fn daemon_input_tracker_keeps_recent_literal_launch_tokens() {
        let mut line = String::new();
        let mut recent = VecDeque::new();
        track_input(&mut line, &mut recent, b"claude-yolo --flag\r");
        track_input(&mut line, &mut recent, b"codx\x7fex resume\r");
        track_input(&mut line, &mut recent, b"ignored\x15opencode\r");
        assert_eq!(
            recent.into_iter().collect::<Vec<_>>(),
            vec!["claude-yolo", "codex", "opencode"]
        );
    }
}
