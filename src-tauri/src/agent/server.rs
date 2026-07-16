use super::host_services;
use super::paths;
use super::repository::{AgentRepository, WorkspaceRepoError};
use super::session_manager::{SessionManager, SpawnRequest};
use crate::remote_protocol::{
    read_frame_async, write_frame_async, AgentHello, ClientHello, EventBody, EventFrame,
    RemoteError, RequestBody, ResponseBody, ResponseFrame, WireMessage, MAX_CHECKPOINT_CHUNK_BYTES,
    PROTOCOL_MAX, PROTOCOL_MIN,
};
use crate::workspace::WorkspaceOperation;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, Mutex, Notify};

const CONTROL_TTL: Duration = Duration::from_secs(15);
const MAX_CHECKPOINT_BYTES: u64 = 64 * 1024 * 1024;
const CLIENT_QUEUE_CAPACITY: usize = 512;
const CLIENT_SEND_TIMEOUT: Duration = Duration::from_secs(5);

struct ControlLease {
    controller_client_id: String,
    epoch: u64,
    heartbeat_at: Instant,
}

struct CheckpointUpload {
    lease_epoch: u64,
    through_seq: u64,
    total_bytes: u64,
    bytes: Vec<u8>,
}

struct AgentState {
    hello: AgentHello,
    repository: Arc<AgentRepository>,
    sessions: SessionManager,
    clients: Mutex<HashMap<String, mpsc::Sender<WireMessage>>>,
    controls: Mutex<HashMap<String, ControlLease>>,
    next_lease_epoch: Mutex<u64>,
    draining: AtomicBool,
    shutdown: Arc<Notify>,
}

impl AgentState {
    async fn broadcast(&self, message: WireMessage) {
        let mut clients = self.clients.lock().await;
        let mut slow = Vec::new();
        clients.retain(|_, sender| match sender.try_send(message.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                slow.push(sender.clone());
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
        drop(clients);
        for sender in slow {
            tokio::spawn(async move {
                let _ = tokio::time::timeout(
                    CLIENT_SEND_TIMEOUT,
                    sender.send(WireMessage::Event(EventFrame {
                        body: EventBody::Warning {
                            code: "slow_client_detached".into(),
                            message: "client fell behind; reconnect to refresh state".into(),
                        },
                    })),
                )
                .await;
            });
        }
    }

    async fn acquire_control(
        &self,
        client_id: &str,
        workspace_id: &str,
        force: bool,
    ) -> Result<u64, RemoteError> {
        self.repository
            .get_workspace(workspace_id)
            .map_err(workspace_error)?;
        let now = Instant::now();
        let mut controls = self.controls.lock().await;
        if let Some(existing) = controls.get_mut(workspace_id) {
            let alive = now.duration_since(existing.heartbeat_at) < CONTROL_TTL;
            if existing.controller_client_id == client_id && alive {
                existing.heartbeat_at = now;
                return Ok(existing.epoch);
            }
            if alive && !force {
                return Err(RemoteError::retryable(
                    "control_held",
                    format!(
                        "workspace is controlled by {}",
                        existing.controller_client_id
                    ),
                ));
            }
        }
        let epoch = {
            let mut next = self.next_lease_epoch.lock().await;
            *next = next.saturating_add(1);
            *next
        };
        controls.insert(
            workspace_id.to_string(),
            ControlLease {
                controller_client_id: client_id.to_string(),
                epoch,
                heartbeat_at: now,
            },
        );
        drop(controls);
        self.broadcast(WireMessage::Event(EventFrame {
            body: EventBody::ControlChanged {
                workspace_id: workspace_id.to_string(),
                controller_client_id: Some(client_id.to_string()),
                lease_epoch: epoch,
            },
        }))
        .await;
        Ok(epoch)
    }

    async fn validate_control(
        &self,
        client_id: &str,
        workspace_id: &str,
        epoch: u64,
        heartbeat: bool,
    ) -> Result<(), RemoteError> {
        let mut controls = self.controls.lock().await;
        let lease = controls
            .get_mut(workspace_id)
            .ok_or_else(|| RemoteError::retryable("control_required", workspace_id))?;
        if lease.controller_client_id != client_id || lease.epoch != epoch {
            return Err(RemoteError::new("stale_control_lease", workspace_id));
        }
        if Instant::now().duration_since(lease.heartbeat_at) >= CONTROL_TTL {
            controls.remove(workspace_id);
            return Err(RemoteError::retryable("control_expired", workspace_id));
        }
        if heartbeat {
            lease.heartbeat_at = Instant::now();
        }
        Ok(())
    }

    async fn release_control(
        &self,
        client_id: &str,
        workspace_id: &str,
        epoch: u64,
    ) -> Result<(), RemoteError> {
        let mut controls = self.controls.lock().await;
        match controls.get(workspace_id) {
            Some(lease) if lease.controller_client_id == client_id && lease.epoch == epoch => {
                controls.remove(workspace_id);
            }
            _ => return Err(RemoteError::new("stale_control_lease", workspace_id)),
        }
        drop(controls);
        self.broadcast(WireMessage::Event(EventFrame {
            body: EventBody::ControlChanged {
                workspace_id: workspace_id.to_string(),
                controller_client_id: None,
                lease_epoch: epoch,
            },
        }))
        .await;
        Ok(())
    }

    async fn release_client(&self, client_id: &str) {
        self.clients.lock().await.remove(client_id);
        self.sessions.detach_client(client_id).await;
        let released = {
            let mut controls = self.controls.lock().await;
            let released = controls
                .iter()
                .filter(|(_, lease)| lease.controller_client_id == client_id)
                .map(|(workspace, lease)| (workspace.clone(), lease.epoch))
                .collect::<Vec<_>>();
            for (workspace, _) in &released {
                controls.remove(workspace);
            }
            released
        };
        for (workspace_id, epoch) in released {
            self.broadcast(WireMessage::Event(EventFrame {
                body: EventBody::ControlChanged {
                    workspace_id,
                    controller_client_id: None,
                    lease_epoch: epoch,
                },
            }))
            .await;
        }
    }

    async fn expire_controls(&self) {
        let expired = {
            let mut controls = self.controls.lock().await;
            let now = Instant::now();
            let expired = controls
                .iter()
                .filter(|(_, lease)| now.duration_since(lease.heartbeat_at) >= CONTROL_TTL)
                .map(|(workspace, lease)| (workspace.clone(), lease.epoch))
                .collect::<Vec<_>>();
            for (workspace, _) in &expired {
                controls.remove(workspace);
            }
            expired
        };
        for (workspace_id, epoch) in expired {
            self.broadcast(WireMessage::Event(EventFrame {
                body: EventBody::ControlChanged {
                    workspace_id,
                    controller_client_id: None,
                    lease_epoch: epoch,
                },
            }))
            .await;
        }
    }
}

pub async fn run_daemon(
    socket_path: Option<PathBuf>,
    database_path: Option<PathBuf>,
) -> Result<(), String> {
    let socket_path = socket_path.unwrap_or_else(paths::socket_path);
    let database_path = database_path.unwrap_or_else(paths::database_path);
    prepare_socket(&socket_path).await?;
    let repository = Arc::new(AgentRepository::open(&database_path)?);
    let device_id = repository.device_id()?;
    let sessions = SessionManager::new(repository.clone());
    let state = Arc::new(AgentState {
        hello: AgentHello {
            selected_protocol: PROTOCOL_MAX,
            agent_version: env!("CARGO_PKG_VERSION").into(),
            device_id,
            hostname: hostname(),
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            capabilities: vec![
                "pty_v1".into(),
                "journal_v1".into(),
                "checkpoint_v1".into(),
                "control_lease_v1".into(),
                "maintenance_v1".into(),
            ],
        },
        repository,
        sessions,
        clients: Mutex::new(HashMap::new()),
        controls: Mutex::new(HashMap::new()),
        next_lease_epoch: Mutex::new(0),
        draining: AtomicBool::new(false),
        shutdown: Arc::new(Notify::new()),
    });
    let listener = UnixListener::bind(&socket_path)
        .map_err(|e| format!("bind agent socket {}: {e}", socket_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod agent socket {}: {e}", socket_path.display()))?;
    }
    eprintln!("yterminal-agent {} ready", env!("CARGO_PKG_VERSION"));

    let mut workspace_updates = state.sessions.subscribe_workspace_updates();
    let workspace_state = state.clone();
    tokio::spawn(async move {
        loop {
            match workspace_updates.recv().await {
                Ok(workspace) => {
                    workspace_state
                        .broadcast(WireMessage::Event(EventFrame {
                            body: EventBody::WorkspaceChanged { workspace },
                        }))
                        .await;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let expiry_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            expiry_state.expire_controls().await;
        }
    });

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted
                    .map_err(|e| format!("accept agent client: {e}"))?;
                let state = state.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_client(stream, state).await {
                        eprintln!("yterminal-agent client ended: {error}");
                    }
                });
            }
            _ = state.shutdown.notified() => {
                let _ = std::fs::remove_file(&socket_path);
                return Ok(());
            }
        }
    }
}

pub async fn connect_stdio(socket_path: Option<PathBuf>) -> Result<(), String> {
    let path = socket_path.unwrap_or_else(paths::socket_path);
    let stream = UnixStream::connect(&path)
        .await
        .map_err(|e| format!("connect agent socket {}: {e}", path.display()))?;
    let (mut socket_reader, mut socket_writer) = stream.into_split();
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let upstream = async {
        tokio::io::copy(&mut stdin, &mut socket_writer)
            .await
            .map_err(|e| format!("copy ssh stdin to agent: {e}"))?;
        socket_writer
            .shutdown()
            .await
            .map_err(|e| format!("shutdown agent socket writer: {e}"))?;
        Ok::<(), String>(())
    };
    let downstream = async {
        tokio::io::copy(&mut socket_reader, &mut stdout)
            .await
            .map_err(|e| format!("copy agent to ssh stdout: {e}"))?;
        stdout
            .flush()
            .await
            .map_err(|e| format!("flush ssh stdout: {e}"))?;
        Ok::<(), String>(())
    };
    tokio::select! {
        result = upstream => result,
        result = downstream => result,
    }
}

async fn handle_client(mut stream: UnixStream, state: Arc<AgentState>) -> Result<(), String> {
    let hello: WireMessage = read_frame_async(&mut stream)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "client closed before handshake".to_string())?;
    let ClientHello {
        protocol_min,
        protocol_max,
        client_id,
        ..
    } = match hello {
        WireMessage::ClientHello(hello) => hello,
        _ => return Err("first message must be client_hello".into()),
    };
    if protocol_max < PROTOCOL_MIN || protocol_min > PROTOCOL_MAX {
        let message = format!(
            "incompatible protocol client={protocol_min}..{protocol_max} agent={PROTOCOL_MIN}..{PROTOCOL_MAX}"
        );
        write_frame_async(
            &mut stream,
            &WireMessage::HandshakeError(RemoteError::new(
                "incompatible_protocol",
                message.clone(),
            )),
        )
        .await
        .map_err(|error| error.to_string())?;
        return Err(message);
    }
    let mut agent_hello = state.hello.clone();
    agent_hello.selected_protocol = protocol_max.min(PROTOCOL_MAX);
    write_frame_async(&mut stream, &WireMessage::AgentHello(agent_hello))
        .await
        .map_err(|e| e.to_string())?;

    let (mut reader, mut writer) = stream.into_split();
    let (outgoing, mut outgoing_rx) = mpsc::channel::<WireMessage>(CLIENT_QUEUE_CAPACITY);
    state
        .clients
        .lock()
        .await
        .insert(client_id.clone(), outgoing.clone());
    let writer_task = tokio::spawn(async move {
        while let Some(message) = outgoing_rx.recv().await {
            write_frame_async(&mut writer, &message)
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok::<(), String>(())
    });

    let mut uploads: HashMap<String, CheckpointUpload> = HashMap::new();
    let read_result = loop {
        let message: WireMessage = match read_frame_async(&mut reader).await {
            Ok(Some(message)) => message,
            Ok(None) => break Ok(()),
            Err(error) => break Err(error.to_string()),
        };
        let request = match message {
            WireMessage::Request(request) => request,
            _ => break Err("expected request after handshake".into()),
        };
        if is_concurrent_request(&request.body) {
            let concurrent_state = state.clone();
            let concurrent_client_id = client_id.clone();
            let concurrent_outgoing = outgoing.clone();
            tokio::spawn(async move {
                let mut no_uploads = HashMap::new();
                let result = handle_request(
                    &concurrent_state,
                    &concurrent_client_id,
                    &concurrent_outgoing,
                    &mut no_uploads,
                    request.body,
                )
                .await;
                let _ = send_response(&concurrent_outgoing, request.request_id, result).await;
            });
            continue;
        }
        let result =
            handle_request(&state, &client_id, &outgoing, &mut uploads, request.body).await;
        if !send_response(&outgoing, request.request_id, result).await {
            break Ok(());
        }
    };

    state.release_client(&client_id).await;
    drop(outgoing);
    writer_task.abort();
    read_result
}

fn is_concurrent_request(request: &RequestBody) -> bool {
    matches!(
        request,
        RequestBody::Ping
            | RequestBody::AgentStatus
            | RequestBody::GetCwd { .. }
            | RequestBody::HomeDir
            | RequestBody::ProcessTree { .. }
            | RequestBody::ResolveAgentSession { .. }
            | RequestBody::GitStatus { .. }
            | RequestBody::GitDiff { .. }
            | RequestBody::PathIsFile { .. }
            | RequestBody::ReadTextFile { .. }
    )
}

async fn send_response(
    outgoing: &mpsc::Sender<WireMessage>,
    request_id: u64,
    result: Result<ResponseBody, RemoteError>,
) -> bool {
    matches!(
        tokio::time::timeout(
            CLIENT_SEND_TIMEOUT,
            outgoing.send(WireMessage::Response(ResponseFrame { request_id, result })),
        )
        .await,
        Ok(Ok(()))
    )
}

async fn handle_request(
    state: &Arc<AgentState>,
    client_id: &str,
    outgoing: &mpsc::Sender<WireMessage>,
    uploads: &mut HashMap<String, CheckpointUpload>,
    request: RequestBody,
) -> Result<ResponseBody, RemoteError> {
    match request {
        RequestBody::Ping => Ok(ResponseBody::Pong),
        RequestBody::AgentStatus => {
            let running_sessions = state.sessions.running_count().await;
            let repository = state.repository.clone();
            let diagnostics = tokio::task::spawn_blocking(move || repository.diagnostics())
                .await
                .map_err(host_task_error)?
                .map_err(|error| RemoteError::new("diagnostics_failed", error))?;
            Ok(ResponseBody::AgentStatus {
                draining: state.draining.load(Ordering::Relaxed),
                running_sessions,
                database_bytes: diagnostics.database_bytes,
                journal_bytes: diagnostics.journal_bytes,
                checkpoint_bytes: diagnostics.checkpoint_bytes,
                dropped_journal_chunks: diagnostics.dropped_journal_chunks,
            })
        }
        RequestBody::SetDraining { draining } => {
            state.draining.store(draining, Ordering::Relaxed);
            Ok(ResponseBody::Ack)
        }
        RequestBody::ShutdownAgent => {
            if !state.draining.load(Ordering::Relaxed) {
                return Err(RemoteError::new(
                    "agent_not_draining",
                    "enable drain mode before restart",
                ));
            }
            let running = state.sessions.running_count().await;
            if running > 0 {
                return Err(RemoteError::new(
                    "sessions_still_running",
                    format!("{running} session(s) are still running"),
                ));
            }
            let shutdown = state.shutdown.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                shutdown.notify_waiters();
            });
            Ok(ResponseBody::Ack)
        }
        RequestBody::ListWorkspaces => {
            let workspaces = state
                .repository
                .list_workspaces()
                .map_err(workspace_error)?;
            Ok(ResponseBody::Workspaces { workspaces })
        }
        RequestBody::GetWorkspace { workspace_id } => {
            let workspace = state
                .repository
                .get_workspace(&workspace_id)
                .map_err(workspace_error)?;
            Ok(ResponseBody::Workspace { workspace })
        }
        RequestBody::ImportWorkspaces { workspaces } => {
            state
                .repository
                .import_workspaces(workspaces)
                .map_err(workspace_error)?;
            // Bind any daemon-owned sessions that were spawned before the
            // one-time frontend import completed.
            for session in state.sessions.list().await {
                if session.state == crate::remote_protocol::SessionState::Running {
                    if let Ok(workspace) = state.repository.apply_workspace_operation_internal(
                        &session.workspace_id,
                        WorkspaceOperation::BindSession {
                            pane_id: session.pane_id,
                            session_id: session.session_id,
                        },
                    ) {
                        state
                            .broadcast(WireMessage::Event(EventFrame {
                                body: EventBody::WorkspaceChanged { workspace },
                            }))
                            .await;
                    }
                }
            }
            let workspaces = state
                .repository
                .list_workspaces()
                .map_err(workspace_error)?;
            for workspace in &workspaces {
                state
                    .broadcast(WireMessage::Event(EventFrame {
                        body: EventBody::WorkspaceChanged {
                            workspace: workspace.clone(),
                        },
                    }))
                    .await;
            }
            Ok(ResponseBody::Workspaces { workspaces })
        }
        RequestBody::CreateWorkspace { workspace } => {
            let workspace = state
                .repository
                .create_workspace(workspace)
                .map_err(workspace_error)?;
            state
                .broadcast(WireMessage::Event(EventFrame {
                    body: EventBody::WorkspaceChanged {
                        workspace: workspace.clone(),
                    },
                }))
                .await;
            Ok(ResponseBody::Workspace { workspace })
        }
        RequestBody::ApplyWorkspaceOp {
            workspace_id,
            base_revision,
            lease_epoch,
            operation,
        } => {
            state
                .validate_control(client_id, &workspace_id, lease_epoch, false)
                .await?;
            let before = state
                .repository
                .get_workspace(&workspace_id)
                .map_err(workspace_error)?;
            let removed_panes = match &operation {
                WorkspaceOperation::ClosePane { pane_id, .. } => vec![pane_id.clone()],
                WorkspaceOperation::RemoveTab { tab_id } => before.pane_ids_for_tab(tab_id),
                _ => Vec::new(),
            };
            let workspace = state
                .repository
                .apply_workspace_operation(&workspace_id, base_revision, operation)
                .map_err(workspace_error)?;
            if !removed_panes.is_empty() {
                let _ = state
                    .sessions
                    .terminate_panes(&workspace_id, &removed_panes)
                    .await;
                state
                    .repository
                    .purge_panes(workspace_id.clone(), removed_panes)
                    .await
                    .map_err(|error| RemoteError::new("session_purge_failed", error))?;
            }
            state
                .broadcast(WireMessage::Event(EventFrame {
                    body: EventBody::WorkspaceChanged {
                        workspace: workspace.clone(),
                    },
                }))
                .await;
            Ok(ResponseBody::Workspace { workspace })
        }
        RequestBody::DeleteWorkspace {
            workspace_id,
            lease_epoch,
        } => {
            state
                .validate_control(client_id, &workspace_id, lease_epoch, false)
                .await?;
            let _ = state.sessions.terminate_workspace(&workspace_id).await;
            state
                .repository
                .purge_workspace(workspace_id.clone())
                .await
                .map_err(|error| RemoteError::new("session_purge_failed", error))?;
            state
                .repository
                .delete_workspace(&workspace_id)
                .map_err(workspace_error)?;
            state
                .broadcast(WireMessage::Event(EventFrame {
                    body: EventBody::WorkspaceRemoved {
                        workspace_id: workspace_id.clone(),
                    },
                }))
                .await;
            Ok(ResponseBody::Ack)
        }
        RequestBody::GetCwd { session_id } => {
            let pid = state.sessions.pid(&session_id).await?;
            let cwd = tokio::task::spawn_blocking(move || host_services::process_cwd(pid))
                .await
                .map_err(host_task_error)?
                .map_err(|error| RemoteError::new("process_cwd_failed", error))?;
            Ok(ResponseBody::Cwd { cwd: Some(cwd) })
        }
        RequestBody::HomeDir => Ok(ResponseBody::HomeDirectory {
            path: host_services::home_dir().map(|path| path.to_string_lossy().into_owned()),
        }),
        RequestBody::ProcessTree { session_id } => {
            let pid = state.sessions.pid(&session_id).await?;
            let processes = tokio::task::spawn_blocking(move || host_services::process_tree(pid))
                .await
                .map_err(host_task_error)?;
            Ok(ResponseBody::Processes {
                processes: bounded_processes(processes),
            })
        }
        RequestBody::ResolveAgentSession { kind, cwd, pid } => {
            let session_id = tokio::task::spawn_blocking(move || {
                host_services::resolve_agent_session(&kind, &cwd, pid)
            })
            .await
            .map_err(host_task_error)?;
            Ok(ResponseBody::AgentSession { session_id })
        }
        RequestBody::GitStatus { dir } => {
            let status = tokio::task::spawn_blocking(move || host_services::git_status(&dir))
                .await
                .map_err(host_task_error)?
                .map_err(|error| RemoteError::new("git_status_failed", error))?;
            Ok(ResponseBody::GitStatus { status })
        }
        RequestBody::GitDiff { dir, path } => {
            let text = tokio::task::spawn_blocking(move || host_services::git_diff(&dir, &path))
                .await
                .map_err(host_task_error)?
                .map_err(|error| RemoteError::new("git_diff_failed", error))?;
            Ok(ResponseBody::Text { text })
        }
        RequestBody::PathIsFile { path } => {
            let value = tokio::task::spawn_blocking(move || host_services::path_is_file(&path))
                .await
                .map_err(host_task_error)?;
            Ok(ResponseBody::Boolean { value })
        }
        RequestBody::ReadTextFile {
            path,
            offset,
            max_bytes,
        } => {
            let (bytes, total_bytes, eof) = tokio::task::spawn_blocking(move || {
                host_services::read_text_file_chunk(&path, offset, max_bytes)
            })
            .await
            .map_err(host_task_error)?
            .map_err(|error| RemoteError::new("read_text_file_failed", error))?;
            Ok(ResponseBody::FileChunk {
                bytes: serde_bytes::ByteBuf::from(bytes),
                total_bytes,
                eof,
            })
        }
        RequestBody::ListSessions => Ok(ResponseBody::Sessions {
            sessions: state.sessions.list().await,
        }),
        RequestBody::SpawnSession {
            workspace_id,
            pane_id,
            lease_epoch,
            file,
            args,
            cols,
            rows,
            cwd,
            env,
        } => {
            if state.draining.load(Ordering::Relaxed) {
                return Err(RemoteError::retryable(
                    "agent_draining",
                    "agent is draining for restart",
                ));
            }
            state
                .validate_control(client_id, &workspace_id, lease_epoch, false)
                .await?;
            let (session_id, pid) = state
                .sessions
                .spawn(SpawnRequest {
                    workspace_id: workspace_id.clone(),
                    pane_id: pane_id.clone(),
                    file,
                    args,
                    cols,
                    rows,
                    cwd,
                    env,
                })
                .await?;
            if let Ok(workspace) = state.repository.apply_workspace_operation_internal(
                &workspace_id,
                WorkspaceOperation::BindSession {
                    pane_id,
                    session_id: session_id.clone(),
                },
            ) {
                state
                    .broadcast(WireMessage::Event(EventFrame {
                        body: EventBody::WorkspaceChanged { workspace },
                    }))
                    .await;
            }
            Ok(ResponseBody::SessionSpawned { session_id, pid })
        }
        RequestBody::AttachSession {
            session_id,
            after_seq,
            ..
        } => {
            state
                .sessions
                .attach(client_id, &session_id, after_seq, outgoing.clone())
                .await?;
            Ok(ResponseBody::Ack)
        }
        RequestBody::DetachSession { session_id } => {
            state.sessions.detach(client_id, &session_id).await?;
            Ok(ResponseBody::Ack)
        }
        RequestBody::Input {
            session_id,
            lease_epoch,
            bytes,
        } => {
            let workspace = state.sessions.workspace_id(&session_id).await?;
            state
                .validate_control(client_id, &workspace, lease_epoch, false)
                .await?;
            state.sessions.input(&session_id, bytes.into_vec()).await?;
            Ok(ResponseBody::Ack)
        }
        RequestBody::Resize {
            session_id,
            lease_epoch,
            cols,
            rows,
        } => {
            let workspace = state.sessions.workspace_id(&session_id).await?;
            state
                .validate_control(client_id, &workspace, lease_epoch, false)
                .await?;
            state.sessions.resize(&session_id, cols, rows).await?;
            Ok(ResponseBody::Ack)
        }
        RequestBody::KillSession {
            session_id,
            lease_epoch,
        } => {
            let workspace = state.sessions.workspace_id(&session_id).await?;
            state
                .validate_control(client_id, &workspace, lease_epoch, false)
                .await?;
            state.sessions.kill(&session_id).await?;
            Ok(ResponseBody::Ack)
        }
        RequestBody::AcquireControl {
            workspace_id,
            force,
        } => {
            let lease_epoch = state
                .acquire_control(client_id, &workspace_id, force)
                .await?;
            Ok(ResponseBody::ControlAcquired {
                workspace_id,
                lease_epoch,
            })
        }
        RequestBody::ReleaseControl {
            workspace_id,
            lease_epoch,
        } => {
            state
                .release_control(client_id, &workspace_id, lease_epoch)
                .await?;
            Ok(ResponseBody::Ack)
        }
        RequestBody::ControlHeartbeat {
            workspace_id,
            lease_epoch,
        } => {
            state
                .validate_control(client_id, &workspace_id, lease_epoch, true)
                .await?;
            Ok(ResponseBody::Ack)
        }
        RequestBody::CheckpointBegin {
            session_id,
            lease_epoch,
            through_seq,
            total_bytes,
        } => {
            if total_bytes > MAX_CHECKPOINT_BYTES {
                return Err(RemoteError::new(
                    "checkpoint_too_large",
                    format!("{total_bytes} > {MAX_CHECKPOINT_BYTES}"),
                ));
            }
            let workspace = state.sessions.workspace_id(&session_id).await?;
            state
                .validate_control(client_id, &workspace, lease_epoch, false)
                .await?;
            uploads.insert(
                session_id,
                CheckpointUpload {
                    lease_epoch,
                    through_seq,
                    total_bytes,
                    bytes: Vec::with_capacity(total_bytes as usize),
                },
            );
            Ok(ResponseBody::Ack)
        }
        RequestBody::CheckpointChunk { session_id, bytes } => {
            if bytes.len() > MAX_CHECKPOINT_CHUNK_BYTES {
                return Err(RemoteError::new(
                    "checkpoint_chunk_too_large",
                    bytes.len().to_string(),
                ));
            }
            let upload = uploads
                .get_mut(&session_id)
                .ok_or_else(|| RemoteError::new("checkpoint_not_started", &session_id))?;
            if upload.bytes.len().saturating_add(bytes.len()) > upload.total_bytes as usize {
                return Err(RemoteError::new("checkpoint_overflow", &session_id));
            }
            upload.bytes.extend_from_slice(&bytes);
            Ok(ResponseBody::Ack)
        }
        RequestBody::CheckpointEnd { session_id } => {
            let upload = uploads
                .remove(&session_id)
                .ok_or_else(|| RemoteError::new("checkpoint_not_started", &session_id))?;
            if upload.bytes.len() as u64 != upload.total_bytes {
                return Err(RemoteError::new(
                    "checkpoint_incomplete",
                    format!("{} != {}", upload.bytes.len(), upload.total_bytes),
                ));
            }
            let workspace = state.sessions.workspace_id(&session_id).await?;
            state
                .validate_control(client_id, &workspace, upload.lease_epoch, false)
                .await?;
            state
                .sessions
                .save_checkpoint(&session_id, upload.through_seq, upload.bytes)
                .await?;
            Ok(ResponseBody::Ack)
        }
    }
}

fn workspace_error(error: WorkspaceRepoError) -> RemoteError {
    match error {
        WorkspaceRepoError::NotFound(message) => RemoteError::new("workspace_not_found", message),
        WorkspaceRepoError::AlreadyExists(message) => {
            RemoteError::new("workspace_already_exists", message)
        }
        WorkspaceRepoError::RevisionConflict { expected, actual } => RemoteError::retryable(
            "workspace_revision_conflict",
            format!("expected {expected}, actual {actual}"),
        ),
        WorkspaceRepoError::Invalid(message) => RemoteError::new("invalid_workspace", message),
        WorkspaceRepoError::Database(message) => {
            RemoteError::retryable("workspace_database_failed", message)
        }
    }
}

fn host_task_error(error: tokio::task::JoinError) -> RemoteError {
    RemoteError::retryable("host_service_task_failed", error.to_string())
}

fn bounded_processes(
    processes: Vec<crate::remote_protocol::RemoteProcessInfo>,
) -> Vec<crate::remote_protocol::RemoteProcessInfo> {
    processes
        .into_iter()
        .take(256)
        .map(|mut process| {
            let mut remaining = 2 * 1024;
            process.argv = process
                .argv
                .into_iter()
                .take(64)
                .filter_map(|argument| {
                    if remaining == 0 {
                        return None;
                    }
                    let argument = truncate_utf8(argument, remaining);
                    remaining = remaining.saturating_sub(argument.len());
                    Some(argument)
                })
                .collect();
            process
        })
        .collect()
}

fn truncate_utf8(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value
}

async fn prepare_socket(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create socket dir {}: {e}", parent.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("chmod socket dir {}: {e}", parent.display()))?;
        }
    }
    if path.exists() {
        match UnixStream::connect(path).await {
            Ok(_) => return Err(format!("agent already running at {}", path.display())),
            Err(_) => std::fs::remove_file(path)
                .map_err(|e| format!("remove stale socket {}: {e}", path.display()))?,
        }
    }
    Ok(())
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_protocol::{
        read_frame_async, write_frame_async, ClientHello, RequestFrame, ResponseBody,
    };
    use crate::workspace::{PaneTree, TabDocument, WorkspaceDocument};
    use std::collections::BTreeMap;
    use uuid::Uuid;

    async fn read_response(stream: &mut UnixStream, request_id: u64) -> ResponseBody {
        read_result(stream, request_id).await.unwrap()
    }

    async fn read_result(
        stream: &mut UnixStream,
        request_id: u64,
    ) -> Result<ResponseBody, RemoteError> {
        loop {
            let message: WireMessage = read_frame_async(stream).await.unwrap().unwrap();
            if let WireMessage::Response(response) = message {
                if response.request_id == request_id {
                    return response.result;
                }
            }
        }
    }

    fn test_workspace() -> WorkspaceDocument {
        WorkspaceDocument {
            id: "workspace-test".into(),
            revision: 0,
            name: "Test".into(),
            icon: None,
            tabs: vec![TabDocument {
                id: "tab-test".into(),
                name: "shell".into(),
                custom_name: None,
                icon: None,
                cwd: "/tmp".into(),
                root: PaneTree::Leaf {
                    id: "pane-test".into(),
                    cwd: "/tmp".into(),
                    session_id: None,
                    agent: None,
                    runtime_status: None,
                    runtime_title: None,
                },
                file: None,
            }],
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn daemon_handshake_spawn_attach_and_replay() {
        let suffix = Uuid::new_v4().to_string();
        // Keep the Unix socket path well below Darwin's ~104-byte limit.
        let root = PathBuf::from("/tmp").join(format!("yt-{}", &suffix[..8]));
        let socket = root.join("agent.sock");
        let database = root.join("agent.db");
        let daemon_socket = socket.clone();
        let daemon_database = database.clone();
        let daemon = tokio::spawn(async move {
            run_daemon(Some(daemon_socket), Some(daemon_database))
                .await
                .unwrap();
        });
        let mut stream = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                match UnixStream::connect(&socket).await {
                    Ok(stream) => break stream,
                    Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
                }
            }
        })
        .await
        .expect("agent socket did not become ready");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        let mut incompatible = UnixStream::connect(&socket).await.unwrap();
        write_frame_async(
            &mut incompatible,
            &WireMessage::ClientHello(ClientHello {
                protocol_min: PROTOCOL_MAX + 1,
                protocol_max: PROTOCOL_MAX + 1,
                app_version: "future".into(),
                client_id: "future-client".into(),
                client_name: "future".into(),
                capabilities: vec![],
            }),
        )
        .await
        .unwrap();
        assert!(matches!(
            read_frame_async::<_, WireMessage>(&mut incompatible)
                .await
                .unwrap()
                .unwrap(),
            WireMessage::HandshakeError(RemoteError { ref code, .. })
                if code == "incompatible_protocol"
        ));

        write_frame_async(
            &mut stream,
            &WireMessage::ClientHello(ClientHello {
                protocol_min: PROTOCOL_MIN,
                protocol_max: PROTOCOL_MAX,
                app_version: "test".into(),
                client_id: "client-test".into(),
                client_name: "test".into(),
                capabilities: vec![],
            }),
        )
        .await
        .unwrap();
        assert!(matches!(
            read_frame_async::<_, WireMessage>(&mut stream)
                .await
                .unwrap()
                .unwrap(),
            WireMessage::AgentHello(_)
        ));

        write_frame_async(
            &mut stream,
            &WireMessage::Request(RequestFrame {
                request_id: 0,
                body: RequestBody::CreateWorkspace {
                    workspace: test_workspace(),
                },
            }),
        )
        .await
        .unwrap();
        assert!(matches!(
            read_response(&mut stream, 0).await,
            ResponseBody::Workspace { .. }
        ));

        write_frame_async(
            &mut stream,
            &WireMessage::Request(RequestFrame {
                request_id: 99,
                body: RequestBody::AttachSession {
                    session_id: "missing".into(),
                    after_seq: None,
                    cols: 80,
                    rows: 24,
                },
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            read_result(&mut stream, 99).await.unwrap_err().code,
            "session_not_found"
        );

        write_frame_async(
            &mut stream,
            &WireMessage::Request(RequestFrame {
                request_id: 1,
                body: RequestBody::AcquireControl {
                    workspace_id: "workspace-test".into(),
                    force: false,
                },
            }),
        )
        .await
        .unwrap();
        let lease_epoch = match read_response(&mut stream, 1).await {
            ResponseBody::ControlAcquired { lease_epoch, .. } => lease_epoch,
            other => panic!("unexpected acquire response: {other:?}"),
        };
        assert!(lease_epoch > 0);

        write_frame_async(
            &mut stream,
            &WireMessage::Request(RequestFrame {
                request_id: 2,
                body: RequestBody::SpawnSession {
                    workspace_id: "workspace-test".into(),
                    pane_id: "pane-test".into(),
                    lease_epoch,
                    file: "/bin/sh".into(),
                    args: vec!["-c".into(), "printf agent-ok; sleep 0.05".into()],
                    cols: 80,
                    rows: 24,
                    cwd: None,
                    env: BTreeMap::new(),
                },
            }),
        )
        .await
        .unwrap();
        let session_id = match read_response(&mut stream, 2).await {
            ResponseBody::SessionSpawned { session_id, .. } => session_id,
            other => panic!("unexpected spawn response: {other:?}"),
        };
        tokio::time::sleep(Duration::from_millis(100)).await;

        write_frame_async(
            &mut stream,
            &WireMessage::Request(RequestFrame {
                request_id: 3,
                body: RequestBody::AttachSession {
                    session_id: session_id.clone(),
                    after_seq: None,
                    cols: 80,
                    rows: 24,
                },
            }),
        )
        .await
        .unwrap();
        let mut output = Vec::new();
        let mut expected_seq = 0u64;
        let mut replay_finished = false;
        let mut exited = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while tokio::time::Instant::now() < deadline && !(replay_finished && exited) {
            let message = tokio::time::timeout(
                Duration::from_millis(500),
                read_frame_async::<_, WireMessage>(&mut stream),
            )
            .await
            .expect("agent event timeout")
            .unwrap()
            .unwrap();
            match message {
                WireMessage::Event(EventFrame {
                    body:
                        EventBody::Output {
                            start_seq, bytes, ..
                        },
                }) => {
                    assert_eq!(start_seq, expected_seq);
                    expected_seq += bytes.len() as u64;
                    output.extend_from_slice(&bytes);
                }
                WireMessage::Event(EventFrame {
                    body: EventBody::ReplayEnd { .. },
                }) => replay_finished = true,
                WireMessage::Event(EventFrame {
                    body: EventBody::Exited { .. },
                }) => exited = true,
                _ => {}
            }
        }
        assert!(replay_finished);
        assert!(exited);
        assert!(String::from_utf8_lossy(&output).contains("agent-ok"));

        write_frame_async(
            &mut stream,
            &WireMessage::Request(RequestFrame {
                request_id: 4,
                body: RequestBody::CheckpointBegin {
                    session_id: session_id.clone(),
                    lease_epoch,
                    through_seq: u64::MAX,
                    total_bytes: 0,
                },
            }),
        )
        .await
        .unwrap();
        assert!(matches!(
            read_response(&mut stream, 4).await,
            ResponseBody::Ack
        ));
        write_frame_async(
            &mut stream,
            &WireMessage::Request(RequestFrame {
                request_id: 5,
                body: RequestBody::CheckpointEnd { session_id },
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            read_result(&mut stream, 5).await.unwrap_err().code,
            "invalid_checkpoint_seq"
        );

        daemon.abort();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn control_lease_rejects_watchers_stale_epochs_and_expired_owner() {
        let root = std::env::temp_dir().join(format!("yt-lease-{}", Uuid::new_v4()));
        let repository = Arc::new(AgentRepository::open(root.join("agent.db")).unwrap());
        repository.create_workspace(test_workspace()).unwrap();
        let sessions = SessionManager::new(repository.clone());
        let state = Arc::new(AgentState {
            hello: AgentHello {
                selected_protocol: PROTOCOL_MAX,
                agent_version: "test".into(),
                device_id: "device".into(),
                hostname: "host".into(),
                os: "test".into(),
                arch: "test".into(),
                capabilities: vec![],
            },
            repository,
            sessions,
            clients: Mutex::new(HashMap::new()),
            controls: Mutex::new(HashMap::new()),
            next_lease_epoch: Mutex::new(0),
            draining: AtomicBool::new(false),
            shutdown: Arc::new(Notify::new()),
        });
        let first = state
            .acquire_control("controller-a", "workspace-test", false)
            .await
            .unwrap();
        let held = state
            .acquire_control("watcher-b", "workspace-test", false)
            .await
            .unwrap_err();
        assert_eq!(held.code, "control_held");
        let second = state
            .acquire_control("watcher-b", "workspace-test", true)
            .await
            .unwrap();
        assert!(second > first);
        let stale = state
            .validate_control("controller-a", "workspace-test", first, false)
            .await
            .unwrap_err();
        assert_eq!(stale.code, "stale_control_lease");
        state
            .controls
            .lock()
            .await
            .get_mut("workspace-test")
            .unwrap()
            .heartbeat_at = Instant::now() - CONTROL_TTL;
        let expired = state
            .validate_control("watcher-b", "workspace-test", second, false)
            .await
            .unwrap_err();
        assert_eq!(expired.code, "control_expired");

        let (slow_tx, mut slow_rx) = mpsc::channel(1);
        slow_tx
            .try_send(WireMessage::Response(ResponseFrame {
                request_id: 1,
                result: Ok(ResponseBody::Pong),
            }))
            .unwrap();
        state.clients.lock().await.insert("slow".into(), slow_tx);
        state
            .broadcast(WireMessage::Response(ResponseFrame {
                request_id: 2,
                result: Ok(ResponseBody::Pong),
            }))
            .await;
        assert!(!state.clients.lock().await.contains_key("slow"));
        let _ = slow_rx.recv().await;
        let warning = tokio::time::timeout(Duration::from_secs(1), slow_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            warning,
            WireMessage::Event(EventFrame {
                body: EventBody::Warning { ref code, .. }
            }) if code == "slow_client_detached"
        ));
        drop(state);
        let _ = std::fs::remove_dir_all(root);
    }
}
