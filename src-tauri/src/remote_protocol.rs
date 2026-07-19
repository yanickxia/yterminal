//! Length-prefixed CBOR protocol used over SSH stdio and the local agent
//! socket. The framing layer is deliberately independent from Tauri so the
//! exact same messages are used for local and remote hosts.

use crate::workspace::{WorkspaceDocument, WorkspaceOperation};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_bytes::ByteBuf;
use std::fmt;
use std::io::{self, Read, Write};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const PROTOCOL_MIN: u16 = 1;
pub const PROTOCOL_MAX: u16 = 1;

/// A normal message is intentionally small. Large terminal checkpoints are
/// sent as a sequence of `CheckpointChunk` requests rather than relaxing this
/// bound and allowing an attacker/process bug to force a huge allocation.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const MAX_OUTPUT_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_CHECKPOINT_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Debug)]
pub enum ProtocolError {
    Io(io::Error),
    Encode(String),
    Decode(String),
    FrameTooLarge { actual: usize, max: usize },
    TruncatedHeader,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "protocol io: {e}"),
            Self::Encode(e) => write!(f, "protocol encode: {e}"),
            Self::Decode(e) => write!(f, "protocol decode: {e}"),
            Self::FrameTooLarge { actual, max } => {
                write!(f, "protocol frame too large: {actual} bytes (max {max})")
            }
            Self::TruncatedHeader => write!(f, "protocol truncated frame header"),
        }
    }
}

impl std::error::Error for ProtocolError {}

impl From<io::Error> for ProtocolError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

/// Encode one CBOR value preceded by a big-endian u32 byte length.
pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<(), ProtocolError> {
    let mut payload = Vec::new();
    ciborium::ser::into_writer(value, &mut payload)
        .map_err(|e| ProtocolError::Encode(e.to_string()))?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: payload.len(),
            max: MAX_FRAME_BYTES,
        });
    }
    writer.write_all(&(payload.len() as u32).to_be_bytes())?;
    writer.write_all(&payload)?;
    Ok(())
}

/// Decode one length-prefixed CBOR value. A clean EOF before a new header is
/// `Ok(None)`; EOF after any header byte is a protocol error.
pub fn read_frame<R: Read, T: DeserializeOwned>(
    reader: &mut R,
) -> Result<Option<T>, ProtocolError> {
    let mut header = [0u8; 4];
    match reader.read(&mut header[..1]) {
        Ok(0) => return Ok(None),
        Ok(1) => {}
        Ok(_) => unreachable!("one-byte read returned more than one byte"),
        Err(e) => return Err(ProtocolError::Io(e)),
    }
    if let Err(e) = reader.read_exact(&mut header[1..]) {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            return Err(ProtocolError::TruncatedHeader);
        }
        return Err(ProtocolError::Io(e));
    }
    let len = u32::from_be_bytes(header) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: len,
            max: MAX_FRAME_BYTES,
        });
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload)?;
    let value = ciborium::de::from_reader(payload.as_slice())
        .map_err(|e| ProtocolError::Decode(e.to_string()))?;
    Ok(Some(value))
}

/// Async counterpart used by the Unix socket and SSH connection loops.
pub async fn write_frame_async<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<(), ProtocolError> {
    let mut payload = Vec::new();
    ciborium::ser::into_writer(value, &mut payload)
        .map_err(|e| ProtocolError::Encode(e.to_string()))?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: payload.len(),
            max: MAX_FRAME_BYTES,
        });
    }
    writer
        .write_all(&(payload.len() as u32).to_be_bytes())
        .await?;
    writer.write_all(&payload).await?;
    writer.flush().await?;
    Ok(())
}

/// Async counterpart used by the Unix socket and SSH connection loops.
pub async fn read_frame_async<R: AsyncRead + Unpin, T: DeserializeOwned>(
    reader: &mut R,
) -> Result<Option<T>, ProtocolError> {
    let mut header = [0u8; 4];
    match reader.read(&mut header[..1]).await {
        Ok(0) => return Ok(None),
        Ok(1) => {}
        Ok(_) => unreachable!("one-byte read returned more than one byte"),
        Err(e) => return Err(ProtocolError::Io(e)),
    }
    if let Err(e) = reader.read_exact(&mut header[1..]).await {
        if e.kind() == io::ErrorKind::UnexpectedEof {
            return Err(ProtocolError::TruncatedHeader);
        }
        return Err(ProtocolError::Io(e));
    }
    let len = u32::from_be_bytes(header) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: len,
            max: MAX_FRAME_BYTES,
        });
    }
    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload).await?;
    let value = ciborium::de::from_reader(payload.as_slice())
        .map_err(|e| ProtocolError::Decode(e.to_string()))?;
    Ok(Some(value))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientHello {
    pub protocol_min: u16,
    pub protocol_max: u16,
    pub app_version: String,
    pub client_id: String,
    pub client_name: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentHello {
    pub selected_protocol: u16,
    pub agent_version: String,
    pub device_id: String,
    pub hostname: String,
    pub os: String,
    pub arch: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)] // serde's public wire shape is clearer without boxed payloads
pub enum WireMessage {
    ClientHello(ClientHello),
    AgentHello(AgentHello),
    HandshakeError(RemoteError),
    Request(RequestFrame),
    Response(ResponseFrame),
    Event(EventFrame),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestFrame {
    pub request_id: u64,
    pub body: RequestBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResponseFrame {
    pub request_id: u64,
    pub result: Result<ResponseBody, RemoteError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventFrame {
    pub body: EventBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl RemoteError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }

    pub fn retryable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)] // stable protocol shape; frames are already heap encoded
pub enum RequestBody {
    Ping,
    AgentStatus,
    SetDraining {
        draining: bool,
    },
    ShutdownAgent,
    ListWorkspaces,
    GetWorkspace {
        workspace_id: String,
    },
    ImportWorkspaces {
        workspaces: Vec<WorkspaceDocument>,
    },
    CreateWorkspace {
        workspace: WorkspaceDocument,
    },
    ApplyWorkspaceOp {
        workspace_id: String,
        base_revision: u64,
        lease_epoch: u64,
        operation: WorkspaceOperation,
    },
    DeleteWorkspace {
        workspace_id: String,
        lease_epoch: u64,
    },
    GetCwd {
        session_id: String,
    },
    HomeDir,
    ProcessTree {
        session_id: String,
    },
    ResolveAgentSession {
        kind: String,
        cwd: String,
        pid: u32,
    },
    GitStatus {
        dir: String,
    },
    GitDiff {
        dir: String,
        path: String,
    },
    PathIsFile {
        path: String,
    },
    ReadTextFile {
        path: String,
        offset: u64,
        max_bytes: u32,
    },
    ListSessions,
    SpawnSession {
        workspace_id: String,
        pane_id: String,
        lease_epoch: u64,
        file: String,
        #[serde(default)]
        args: Vec<String>,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        #[serde(default)]
        env: std::collections::BTreeMap<String, String>,
    },
    AttachSession {
        session_id: String,
        after_seq: Option<u64>,
        cols: u16,
        rows: u16,
    },
    DetachSession {
        session_id: String,
    },
    Input {
        session_id: String,
        lease_epoch: u64,
        bytes: ByteBuf,
    },
    Resize {
        session_id: String,
        lease_epoch: u64,
        cols: u16,
        rows: u16,
    },
    KillSession {
        session_id: String,
        lease_epoch: u64,
    },
    AcquireControl {
        workspace_id: String,
        force: bool,
    },
    ReleaseControl {
        workspace_id: String,
        lease_epoch: u64,
    },
    ControlHeartbeat {
        workspace_id: String,
        lease_epoch: u64,
    },
    CheckpointBegin {
        session_id: String,
        lease_epoch: u64,
        through_seq: u64,
        total_bytes: u64,
    },
    CheckpointChunk {
        session_id: String,
        bytes: ByteBuf,
    },
    CheckpointEnd {
        session_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum ResponseBody {
    Pong,
    Ack,
    AgentStatus {
        draining: bool,
        running_sessions: u32,
        database_bytes: u64,
        journal_bytes: u64,
        checkpoint_bytes: u64,
        dropped_journal_chunks: u64,
    },
    Workspaces {
        workspaces: Vec<WorkspaceDocument>,
    },
    Workspace {
        workspace: WorkspaceDocument,
    },
    Cwd {
        cwd: Option<String>,
    },
    HomeDirectory {
        path: Option<String>,
    },
    Processes {
        processes: Vec<RemoteProcessInfo>,
    },
    AgentSession {
        session_id: Option<String>,
    },
    GitStatus {
        status: RemoteGitStatus,
    },
    Text {
        text: String,
    },
    Boolean {
        value: bool,
    },
    FileChunk {
        bytes: ByteBuf,
        total_bytes: u64,
        eof: bool,
    },
    SessionSpawned {
        session_id: String,
        pid: Option<u32>,
    },
    Sessions {
        sessions: Vec<SessionInfo>,
    },
    ControlAcquired {
        workspace_id: String,
        lease_epoch: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub pane_id: String,
    pub workspace_id: String,
    pub state: SessionState,
    pub pid: Option<u32>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub head_seq: u64,
    pub exit_code: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Running,
    Exited,
    Lost,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGitFile {
    pub path: String,
    pub status: String,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub root: String,
    pub files: Vec<RemoteGitFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
pub enum EventBody {
    WorkspaceChanged {
        workspace: WorkspaceDocument,
    },
    WorkspaceRemoved {
        workspace_id: String,
    },
    ReplayBegin {
        session_id: String,
        reset: bool,
        base_seq: u64,
        head_seq: u64,
    },
    CheckpointChunk {
        session_id: String,
        bytes: ByteBuf,
    },
    Output {
        session_id: String,
        start_seq: u64,
        bytes: ByteBuf,
    },
    ReplayEnd {
        session_id: String,
        next_seq: u64,
    },
    SizeChanged {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Exited {
        session_id: String,
        exit_code: u32,
    },
    ControlChanged {
        workspace_id: String,
        controller_client_id: Option<String>,
        lease_epoch: u64,
    },
    Warning {
        code: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn hello() -> WireMessage {
        WireMessage::ClientHello(ClientHello {
            protocol_min: 1,
            protocol_max: 2,
            app_version: "0.18.0".into(),
            client_id: "client-a".into(),
            client_name: "Mac".into(),
            capabilities: vec!["pty_v1".into()],
        })
    }

    #[test]
    fn frame_round_trip() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &hello()).unwrap();
        let decoded: WireMessage = read_frame(&mut Cursor::new(bytes)).unwrap().unwrap();
        assert_eq!(decoded, hello());
    }

    #[test]
    fn preserves_binary_bytes_without_utf8() {
        let message = WireMessage::Request(RequestFrame {
            request_id: 7,
            body: RequestBody::Input {
                session_id: "s1".into(),
                lease_epoch: 3,
                bytes: ByteBuf::from(vec![0, 0xff, 0x1b, b'[', b'A']),
            },
        });
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &message).unwrap();
        let decoded: WireMessage = read_frame(&mut Cursor::new(bytes)).unwrap().unwrap();
        assert_eq!(decoded, message);
    }

    #[test]
    fn decodes_back_to_back_frames() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &hello()).unwrap();
        write_frame(
            &mut bytes,
            &WireMessage::Request(RequestFrame {
                request_id: 1,
                body: RequestBody::Ping,
            }),
        )
        .unwrap();
        let mut cursor = Cursor::new(bytes);
        assert_eq!(
            read_frame::<_, WireMessage>(&mut cursor).unwrap(),
            Some(hello())
        );
        assert!(matches!(
            read_frame::<_, WireMessage>(&mut cursor).unwrap(),
            Some(WireMessage::Request(RequestFrame {
                body: RequestBody::Ping,
                ..
            }))
        ));
        assert_eq!(read_frame::<_, WireMessage>(&mut cursor).unwrap(), None);
    }

    #[test]
    fn rejects_unknown_message_type() {
        let mut payload = Vec::new();
        ciborium::ser::into_writer(
            &serde_json::json!({ "type": "future_protocol_message", "payload": {} }),
            &mut payload,
        )
        .unwrap();
        let mut framed = (payload.len() as u32).to_be_bytes().to_vec();
        framed.extend_from_slice(&payload);
        assert!(matches!(
            read_frame::<_, WireMessage>(&mut Cursor::new(framed)),
            Err(ProtocolError::Decode(_))
        ));
    }

    #[test]
    fn rejects_oversized_header_before_allocating_payload() {
        let bytes = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes().to_vec();
        let err = read_frame::<_, WireMessage>(&mut Cursor::new(bytes)).unwrap_err();
        assert!(matches!(err, ProtocolError::FrameTooLarge { .. }));
    }

    #[test]
    fn distinguishes_clean_eof_from_truncated_header() {
        assert_eq!(
            read_frame::<_, WireMessage>(&mut Cursor::new(Vec::<u8>::new())).unwrap(),
            None
        );
        let err = read_frame::<_, WireMessage>(&mut Cursor::new(vec![0, 0])).unwrap_err();
        assert!(matches!(err, ProtocolError::TruncatedHeader));
    }

    #[test]
    fn rejects_large_encoded_value() {
        #[derive(Serialize)]
        struct Large {
            #[serde(with = "serde_bytes")]
            bytes: Vec<u8>,
        }
        let err = write_frame(
            &mut Vec::new(),
            &Large {
                bytes: vec![0; MAX_FRAME_BYTES + 1],
            },
        )
        .unwrap_err();
        assert!(matches!(err, ProtocolError::FrameTooLarge { .. }));
    }

    #[tokio::test]
    async fn async_frame_round_trip() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let expected = hello();
        let writer = tokio::spawn(async move {
            write_frame_async(&mut client, &expected).await.unwrap();
        });
        let decoded: WireMessage = read_frame_async(&mut server).await.unwrap().unwrap();
        writer.await.unwrap();
        assert_eq!(decoded, hello());
    }
}
