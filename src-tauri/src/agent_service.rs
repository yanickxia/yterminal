pub use yterminal::agent::service::AgentServiceStatus;

#[tauri::command]
pub async fn agent_service_status() -> Result<AgentServiceStatus, String> {
    yterminal::agent::service::status().await
}

#[tauri::command]
pub async fn install_agent_service() -> Result<AgentServiceStatus, String> {
    yterminal::agent::service::install().await
}

#[tauri::command]
pub async fn start_agent_service() -> Result<AgentServiceStatus, String> {
    yterminal::agent::service::start_after_drain().await
}

/// Restart the managed daemon in place, tolerating live sessions. Respawned
/// panes inherit their predecessor's scrollback (checkpoint inheritance), and
/// the frontend reconnects on its own — no drain and no zero-session gate,
/// unlike `start_agent_service`. Mirrors the CLI `hot-restart`.
#[tauri::command]
pub async fn hot_restart_agent_service() -> Result<AgentServiceStatus, String> {
    yterminal::agent::service::restart().await
}
