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
