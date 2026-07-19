#[path = "../../src-tauri/src/agent/host_services.rs"]
pub mod host_services;

#[path = "../../src-tauri/src/agent/osc.rs"]
pub mod osc;

#[path = "../../src-tauri/src/agent/paths.rs"]
pub mod paths;

#[path = "../../src-tauri/src/agent/repository.rs"]
pub mod repository;

#[path = "../../src-tauri/src/agent/service.rs"]
pub mod service;

#[path = "../../src-tauri/src/agent/server.rs"]
pub mod server;

#[path = "../../src-tauri/src/agent/session_manager.rs"]
pub mod session_manager;

pub use server::{connect_stdio, run_daemon};
