#[path = "../../src-tauri/src/workspace.rs"]
pub mod workspace;

#[path = "../../src-tauri/src/remote_protocol.rs"]
pub mod remote_protocol;

#[cfg(unix)]
#[path = "../../src-tauri/src/agent_client.rs"]
pub mod agent_client;

#[cfg(unix)]
pub mod agent;
