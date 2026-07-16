use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::ipc::Channel;
use tokio::process::Child;
use tokio::sync::{mpsc, Mutex, RwLock};
use uuid::Uuid;
use yterminal::agent::paths;
use yterminal::agent_client::{AgentClient, AgentClientEvent, EVENT_CAPACITY};
use yterminal::remote_protocol::{AgentHello, EventBody, RemoteError, RequestBody, ResponseBody};

struct HostConnection {
    client: AgentClient,
    ssh_child: Mutex<Option<Child>>,
}

#[derive(Default)]
pub struct HostConnectionState {
    connections: RwLock<HashMap<String, HostConnection>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConnectOptions {
    pub kind: String,
    pub ssh_target: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConnectionInfo {
    pub connection_id: String,
    pub hello: AgentHello,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum HostEvent {
    Agent(EventBody),
    Diagnostic { message: String },
    Disconnected { message: String },
}

#[tauri::command]
pub async fn host_connect(
    options: HostConnectOptions,
    on_event: Channel<HostEvent>,
    state: tauri::State<'_, HostConnectionState>,
) -> Result<HostConnectionInfo, String> {
    let (event_tx, mut event_rx) = mpsc::channel(EVENT_CAPACITY);
    let name = options.name.unwrap_or_else(|| "yterminal".into());
    let (client, ssh_child) = match options.kind.as_str() {
        "local" => {
            ensure_local_agent().await?;
            (AgentClient::connect_local(name, event_tx).await?, None)
        }
        "ssh" => {
            let target = options
                .ssh_target
                .as_deref()
                .ok_or_else(|| "sshTarget is required".to_string())?;
            let (client, child) = AgentClient::connect_ssh(target, name, event_tx).await?;
            (client, Some(child))
        }
        other => return Err(format!("unknown host connection kind: {other}")),
    };
    let connection_id = Uuid::new_v4().to_string();
    let hello = client.hello.clone();
    state.connections.write().await.insert(
        connection_id.clone(),
        HostConnection {
            client,
            ssh_child: Mutex::new(ssh_child),
        },
    );
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let event = match event {
                AgentClientEvent::Message(body) => HostEvent::Agent(body),
                AgentClientEvent::Diagnostic(message) => HostEvent::Diagnostic { message },
                AgentClientEvent::Disconnected(message) => HostEvent::Disconnected { message },
            };
            if on_event.send(event).is_err() {
                break;
            }
        }
    });
    Ok(HostConnectionInfo {
        connection_id,
        hello,
    })
}

#[tauri::command]
pub async fn host_request(
    connection_id: String,
    request: RequestBody,
    state: tauri::State<'_, HostConnectionState>,
) -> Result<ResponseBody, RemoteError> {
    let client = state
        .connections
        .read()
        .await
        .get(&connection_id)
        .map(|connection| connection.client.clone())
        .ok_or_else(|| RemoteError::new("connection_not_found", &connection_id))?;
    client.request(request).await
}

#[tauri::command]
pub async fn host_notify(
    connection_id: String,
    request: RequestBody,
    state: tauri::State<'_, HostConnectionState>,
) -> Result<(), RemoteError> {
    let client = state
        .connections
        .read()
        .await
        .get(&connection_id)
        .map(|connection| connection.client.clone())
        .ok_or_else(|| RemoteError::new("connection_not_found", &connection_id))?;
    client.notify(request).await
}

#[tauri::command]
pub async fn host_disconnect(
    connection_id: String,
    state: tauri::State<'_, HostConnectionState>,
) -> Result<(), String> {
    if let Some(connection) = state.connections.write().await.remove(&connection_id) {
        if let Some(mut child) = connection.ssh_child.lock().await.take() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
        }
    }
    Ok(())
}

async fn ensure_local_agent() -> Result<(), String> {
    let socket = paths::socket_path();
    if tokio::net::UnixStream::connect(&socket).await.is_ok() {
        return Ok(());
    }
    let (program, args) = locate_agent_command()?;
    std::process::Command::new(&program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("start local yterminal-agent {}: {e}", program.display()))?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if tokio::net::UnixStream::connect(&socket).await.is_ok() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "local yterminal-agent did not create {}",
                socket.display()
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

fn locate_agent_command() -> Result<(PathBuf, Vec<String>), String> {
    if let Some(path) = std::env::var_os("YTERMINAL_AGENT_PATH") {
        return Ok((PathBuf::from(path), vec!["daemon".into()]));
    }
    let current = std::env::current_exe().map_err(|e| format!("current executable: {e}"))?;
    if let Some(dir) = current.parent() {
        let sibling = dir.join("yterminal-agent");
        if sibling.is_file() {
            return Ok((sibling, vec!["daemon".into()]));
        }
        // macOS app bundles place helper executables in Contents/MacOS or
        // Contents/Resources depending on the bundler configuration.
        let resource = dir.join("../Resources/yterminal-agent");
        if resource.is_file() {
            return Ok((resource, vec!["daemon".into()]));
        }
    }
    // Development fallback: the Tauri executable itself understands this
    // private mode, so `tauri dev` does not require a separately built sidecar.
    // It also guarantees that a stopped/outdated installed service cannot
    // prevent the new GUI from starting far enough to offer "Install update".
    Ok((current, vec!["--agent-daemon".into()]))
}
