//! Client for one yterminal-agent connection. The transport can be a local
//! Unix socket or an OpenSSH child's stdin/stdout; request correlation and
//! event delivery are identical above that boundary.

use crate::agent::paths;
use crate::remote_protocol::{
    read_frame_async, write_frame_async, AgentHello, ClientHello, EventBody, RemoteError,
    RequestBody, RequestFrame, ResponseBody, WireMessage, PROTOCOL_MAX, PROTOCOL_MIN,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use uuid::Uuid;

const OUTGOING_CAPACITY: usize = 512;
pub const EVENT_CAPACITY: usize = 512;
type PendingRequests = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<ResponseBody, RemoteError>>>>>;

#[derive(Debug, Clone)]
pub enum AgentClientEvent {
    Message(EventBody),
    Diagnostic(String),
    Disconnected(String),
}

#[derive(Clone)]
pub struct AgentClient {
    pub hello: AgentHello,
    outgoing: mpsc::Sender<WireMessage>,
    pending: PendingRequests,
    next_request_id: Arc<AtomicU64>,
}

impl AgentClient {
    pub async fn connect_local(
        client_name: impl Into<String>,
        events: mpsc::Sender<AgentClientEvent>,
    ) -> Result<Self, String> {
        let stream = UnixStream::connect(paths::socket_path())
            .await
            .map_err(|e| format!("connect local yterminal-agent: {e}"))?;
        let (reader, writer) = stream.into_split();
        Self::connect_parts(reader, writer, client_name.into(), events).await
    }

    pub async fn connect_local_path(
        path: PathBuf,
        client_name: impl Into<String>,
        events: mpsc::Sender<AgentClientEvent>,
    ) -> Result<Self, String> {
        let stream = UnixStream::connect(&path)
            .await
            .map_err(|e| format!("connect local agent {}: {e}", path.display()))?;
        let (reader, writer) = stream.into_split();
        Self::connect_parts(reader, writer, client_name.into(), events).await
    }

    pub async fn connect_ssh(
        ssh_target: &str,
        client_name: impl Into<String>,
        events: mpsc::Sender<AgentClientEvent>,
    ) -> Result<(Self, Child), String> {
        validate_ssh_target(ssh_target)?;
        let mut child = Command::new(ssh_program())
            .arg("-T")
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("ServerAliveInterval=15")
            .arg("-o")
            .arg("ServerAliveCountMax=3")
            .arg("-o")
            .arg("ConnectTimeout=8")
            .arg("--")
            .arg(ssh_target)
            .arg("~/.local/bin/yterminal-agent connect")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("start OpenSSH: {e}"))?;
        let reader = child
            .stdout
            .take()
            .ok_or_else(|| "OpenSSH stdout unavailable".to_string())?;
        let writer = child
            .stdin
            .take()
            .ok_or_else(|| "OpenSSH stdin unavailable".to_string())?;
        let mut stderr = child.stderr.take();
        let handshake = tokio::time::timeout(
            std::time::Duration::from_secs(12),
            Self::connect_parts(reader, writer, client_name.into(), events.clone()),
        )
        .await
        .map_err(|_| "SSH agent handshake timed out".to_string())
        .and_then(|result| result);
        match handshake {
            Ok(client) => {
                if let Some(stderr) = stderr.take() {
                    let diagnostics = events.clone();
                    tokio::spawn(async move {
                        use tokio::io::AsyncReadExt;
                        let mut bytes = Vec::new();
                        let _ = stderr.take(64 * 1024).read_to_end(&mut bytes).await;
                        let message = String::from_utf8_lossy(&bytes).trim().to_string();
                        if !message.is_empty() {
                            let _ = diagnostics
                                .send(AgentClientEvent::Diagnostic(message))
                                .await;
                        }
                    });
                }
                Ok((client, child))
            }
            Err(error) => {
                let _ = child.start_kill();
                let diagnostic = if let Some(stderr) = stderr {
                    use tokio::io::AsyncReadExt;
                    let mut bytes = Vec::new();
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(1),
                        stderr.take(64 * 1024).read_to_end(&mut bytes),
                    )
                    .await;
                    String::from_utf8_lossy(&bytes).trim().to_string()
                } else {
                    String::new()
                };
                let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
                if diagnostic.is_empty() {
                    Err(error)
                } else {
                    Err(format!("{error}: {diagnostic}"))
                }
            }
        }
    }

    async fn connect_parts<R, W>(
        mut reader: R,
        mut writer: W,
        client_name: String,
        events: mpsc::Sender<AgentClientEvent>,
    ) -> Result<Self, String>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let client_id = Uuid::new_v4().to_string();
        write_frame_async(
            &mut writer,
            &WireMessage::ClientHello(ClientHello {
                protocol_min: PROTOCOL_MIN,
                protocol_max: PROTOCOL_MAX,
                app_version: env!("CARGO_PKG_VERSION").into(),
                client_id,
                client_name,
                capabilities: vec![
                    "pty_v1".into(),
                    "journal_v1".into(),
                    "checkpoint_v1".into(),
                    "control_lease_v1".into(),
                ],
            }),
        )
        .await
        .map_err(|e| e.to_string())?;
        let hello = match read_frame_async::<_, WireMessage>(&mut reader)
            .await
            .map_err(|e| e.to_string())?
        {
            Some(WireMessage::AgentHello(hello)) => hello,
            Some(WireMessage::HandshakeError(error)) => {
                return Err(format!("{}: {}", error.code, error.message));
            }
            Some(_) => return Err("agent returned a non-handshake message".into()),
            None => return Err("agent closed during handshake".into()),
        };
        if hello.selected_protocol < PROTOCOL_MIN || hello.selected_protocol > PROTOCOL_MAX {
            return Err(format!(
                "incompatible protocol selected={} client={}..{}",
                hello.selected_protocol, PROTOCOL_MIN, PROTOCOL_MAX
            ));
        }

        let (outgoing, mut outgoing_rx) = mpsc::channel::<WireMessage>(OUTGOING_CAPACITY);
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let writer_events = events.clone();
        tokio::spawn(async move {
            while let Some(message) = outgoing_rx.recv().await {
                if let Err(error) = write_frame_async(&mut writer, &message).await {
                    let _ = writer_events
                        .send(AgentClientEvent::Disconnected(error.to_string()))
                        .await;
                    break;
                }
            }
            let _ = writer.shutdown().await;
        });
        let reader_pending = pending.clone();
        tokio::spawn(async move {
            let disconnect_reason = loop {
                match read_frame_async::<_, WireMessage>(&mut reader).await {
                    Ok(Some(WireMessage::Response(response))) => {
                        if let Some(waiter) =
                            reader_pending.lock().await.remove(&response.request_id)
                        {
                            let _ = waiter.send(response.result);
                        }
                    }
                    Ok(Some(WireMessage::Event(event))) => {
                        if events
                            .try_send(AgentClientEvent::Message(event.body))
                            .is_err()
                        {
                            break "client event queue overflow".to_string();
                        }
                    }
                    Ok(Some(_)) => break "unexpected handshake message".to_string(),
                    Ok(None) => break "agent connection closed".to_string(),
                    Err(error) => break error.to_string(),
                }
            };
            let pending = std::mem::take(&mut *reader_pending.lock().await);
            for (_, waiter) in pending {
                let _ = waiter.send(Err(RemoteError::retryable(
                    "disconnected",
                    disconnect_reason.clone(),
                )));
            }
            let _ = events
                .send(AgentClientEvent::Disconnected(disconnect_reason))
                .await;
        });

        Ok(Self {
            hello,
            outgoing,
            pending,
            next_request_id: Arc::new(AtomicU64::new(1)),
        })
    }

    pub async fn request(&self, body: RequestBody) -> Result<ResponseBody, RemoteError> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (reply, wait) = oneshot::channel();
        self.pending.lock().await.insert(request_id, reply);
        if self
            .outgoing
            .send(WireMessage::Request(RequestFrame { request_id, body }))
            .await
            .is_err()
        {
            self.pending.lock().await.remove(&request_id);
            return Err(RemoteError::retryable(
                "disconnected",
                "agent writer stopped",
            ));
        }
        wait.await
            .map_err(|_| RemoteError::retryable("disconnected", "agent response channel closed"))?
    }

    /// Queue a latency-sensitive request without waiting for its ACK. The
    /// reader safely ignores the unmatched response. Used for PTY input and
    /// resize; ordered SSH/socket delivery is still preserved.
    pub async fn notify(&self, body: RequestBody) -> Result<(), RemoteError> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        self.outgoing
            .send(WireMessage::Request(RequestFrame { request_id, body }))
            .await
            .map_err(|_| RemoteError::retryable("disconnected", "agent writer stopped"))
    }
}

fn ssh_program() -> std::ffi::OsString {
    std::env::var_os("YTERMINAL_SSH_BIN").unwrap_or_else(|| "ssh".into())
}

pub fn validate_ssh_target(target: &str) -> Result<(), String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Err("SSH target is empty".into());
    }
    if trimmed.starts_with('-') {
        return Err("SSH target must not start with '-'".into());
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("SSH target must not contain whitespace/control characters".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_target_validation_rejects_option_injection() {
        assert!(validate_ssh_target("office-linux").is_ok());
        assert!(validate_ssh_target("user@10.0.0.2").is_ok());
        assert!(validate_ssh_target("").is_err());
        assert!(validate_ssh_target("-oProxyCommand=bad").is_err());
        assert!(validate_ssh_target("host command").is_err());
        assert!(validate_ssh_target("host\nother").is_err());
    }
}
