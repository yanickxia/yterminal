//! Shared native core used by both the Tauri application and the headless
//! `yterminal-agent` process.

pub mod remote_protocol;
pub mod workspace;

#[cfg(unix)]
pub mod agent;

#[cfg(unix)]
pub mod agent_client;
