#[cfg(unix)]
use serde::Serialize;
#[cfg(unix)]
use serde_bytes::ByteBuf;
#[cfg(unix)]
use std::collections::BTreeMap;
#[cfg(unix)]
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::time::{Duration, Instant};
#[cfg(unix)]
use tokio::sync::mpsc;
#[cfg(unix)]
use uuid::Uuid;

#[cfg(unix)]
use yterminal::agent::service::{self, AgentServiceStatus};
#[cfg(unix)]
use yterminal::agent_client::{AgentClient, AgentClientEvent, EVENT_CAPACITY};
#[cfg(unix)]
use yterminal::remote_protocol::{EventBody, RemoteError, RequestBody, ResponseBody, SessionInfo};
#[cfg(unix)]
use yterminal::workspace::{
    PaneAgentSummary, PaneTree, SplitDirection, TabDocument, WorkspaceDocument, WorkspaceOperation,
};

#[cfg(unix)]
#[allow(dead_code)] // also included as a module by the packaged GUI binary
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("yterminal-agent: {error}");
        std::process::exit(1);
    }
}

#[cfg(unix)]
#[derive(Default)]
struct Cli {
    command: String,
    positionals: Vec<String>,
    socket: Option<PathBuf>,
    database: Option<PathBuf>,
    json: bool,
    name: Option<String>,
    cwd: Option<String>,
    pane: Option<String>,
    file: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    after_seq: Option<u64>,
    timeout_ms: Option<u64>,
    lease_epoch: Option<u64>,
    keep: bool,
    force: bool,
    newline: bool,
    take_control: bool,
}

#[cfg(unix)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    service: Option<AgentServiceStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    socket: Option<String>,
    runtime: Option<RuntimeStatus>,
}

#[cfg(unix)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    draining: bool,
    running_sessions: u32,
    database_bytes: u64,
    journal_bytes: u64,
    checkpoint_bytes: u64,
    dropped_journal_chunks: u64,
}

#[cfg(unix)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCreatedOutput {
    workspace_id: String,
    tab_id: String,
    pane_id: String,
    revision: u64,
    cwd: String,
}

#[cfg(unix)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlOutput {
    workspace_id: String,
    lease_epoch: u64,
    released_on_exit: bool,
}

#[cfg(unix)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpawnOutput {
    workspace_id: String,
    pane_id: String,
    session_id: String,
    pid: Option<u32>,
    lease_epoch: u64,
}

#[cfg(unix)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeOutput {
    workspace_id: String,
    pane_id: String,
    session_id: String,
    marker: String,
    observed_marker: bool,
    exit_code: Option<u32>,
    cleaned_up: bool,
}

#[cfg(unix)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyOutput {
    workspace_id: String,
    imported_workspace_id: String,
    session_id: String,
    marker: String,
    replay_marker: String,
    checks: Vec<String>,
    lease_epochs: Vec<u64>,
    cleaned_up: bool,
}

#[cfg(unix)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlHoldOutput {
    workspace_id: String,
    lease_epoch: u64,
    held_ms: u64,
    heartbeats: u64,
    released: bool,
}

#[cfg(unix)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HotRestartOutput {
    restarted: bool,
    version_before: String,
    version_after: String,
    sessions_before: usize,
    sessions_after: usize,
}

#[cfg(unix)]
struct AgentConnection {
    client: AgentClient,
    events_rx: mpsc::Receiver<AgentClientEvent>,
}

#[cfg(unix)]
pub(crate) async fn run() -> Result<(), String> {
    let cli = parse_cli()?;
    match cli.command.as_str() {
        "daemon" => {
            require_no_positionals(&cli)?;
            yterminal::agent::run_daemon(cli.socket, cli.database).await
        }
        "connect" => {
            require_no_positionals(&cli)?;
            yterminal::agent::connect_stdio(cli.socket).await
        }
        "version" | "--version" | "-V" => {
            require_no_positionals(&cli)?;
            println!("yterminal-agent {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        "status" => {
            require_no_positionals(&cli)?;
            print_status(&cli).await
        }
        "install" => {
            require_no_positionals(&cli)?;
            let status = service::install().await?;
            print_service_status(&status);
            Ok(())
        }
        "start" => {
            require_no_positionals(&cli)?;
            let status = service::start().await?;
            print_service_status(&status);
            Ok(())
        }
        "restart" => {
            require_no_positionals(&cli)?;
            let status = service::restart().await?;
            print_service_status(&status);
            Ok(())
        }
        "hot-restart" => hot_restart_command(&cli).await,
        "stop" => {
            require_no_positionals(&cli)?;
            let status = service::stop().await?;
            print_service_status(&status);
            Ok(())
        }
        "ping" => {
            require_no_positionals(&cli)?;
            match agent_request(&cli, RequestBody::Ping).await? {
                ResponseBody::Pong => {
                    println!("pong");
                    Ok(())
                }
                other => Err(format!("unexpected ping response: {other:?}")),
            }
        }
        "sessions" => {
            require_no_positionals(&cli)?;
            match agent_request(&cli, RequestBody::ListSessions).await? {
                ResponseBody::Sessions { sessions } => print_sessions(&sessions, cli.json),
                other => Err(format!("unexpected sessions response: {other:?}")),
            }
        }
        "workspaces" | "list-workspaces" => {
            require_no_positionals(&cli)?;
            print_workspaces(&cli).await
        }
        "workspace-get" => print_workspace_get(&cli).await,
        "workspace-create" => create_workspace(&cli).await,
        "workspace-delete" => delete_workspace(&cli).await,
        "control" => acquire_control_command(&cli).await,
        "control-hold" => hold_control_command(&cli).await,
        "spawn" => spawn_command(&cli).await,
        "attach" => attach_command(&cli).await,
        "input" => input_command(&cli, false).await,
        "input-line" => input_command(&cli, true).await,
        "resize" => resize_command(&cli).await,
        "kill" => kill_command(&cli).await,
        "smoke" | "self-test" => smoke_command(&cli).await,
        "verify" | "protocol-smoke" => verify_command(&cli).await,
        "drain" => {
            let value = parse_drain_value(&cli)?;
            match agent_request(&cli, RequestBody::SetDraining { draining: value }).await? {
                ResponseBody::Ack => print_status(&cli).await,
                other => Err(format!("unexpected drain response: {other:?}")),
            }
        }
        "shutdown" => {
            require_no_positionals(&cli)?;
            match agent_request(&cli, RequestBody::ShutdownAgent).await? {
                ResponseBody::Ack => {
                    println!("shutdown requested");
                    Ok(())
                }
                other => Err(format!("unexpected shutdown response: {other:?}")),
            }
        }
        "doctor" => {
            require_no_positionals(&cli)?;
            print_status(&cli).await?;
            match agent_request(&cli, RequestBody::Ping).await? {
                ResponseBody::Pong => println!("protocol: ok"),
                other => return Err(format!("unexpected ping response: {other:?}")),
            }
            Ok(())
        }
        "help" | "--help" | "-h" => {
            match cli.positionals.as_slice() {
                [] => print_help(),
                [command] => print_command_help(command)?,
                _ => return Err("usage: yterminal-agent help [COMMAND]".into()),
            }
            Ok(())
        }
        _ => Err(format!("unknown command: {}", cli.command)),
    }
}

#[cfg(unix)]
#[allow(dead_code)] // used by the packaged GUI binary, not the standalone include
pub(crate) fn handles_command(command: &str) -> bool {
    matches!(
        command,
        "daemon"
            | "connect"
            | "version"
            | "--version"
            | "-V"
            | "status"
            | "install"
            | "start"
            | "restart"
            | "hot-restart"
            | "stop"
            | "ping"
            | "sessions"
            | "workspaces"
            | "list-workspaces"
            | "workspace"
            | "workspace-get"
            | "workspace-create"
            | "workspace-delete"
            | "session"
            | "control"
            | "control-hold"
            | "spawn"
            | "attach"
            | "input"
            | "input-line"
            | "resize"
            | "kill"
            | "smoke"
            | "self-test"
            | "verify"
            | "protocol-smoke"
            | "drain"
            | "shutdown"
            | "doctor"
            | "help"
            | "--help"
            | "-h"
    )
}

#[cfg(unix)]
fn parse_cli() -> Result<Cli, String> {
    let mut args = std::env::args().skip(1);
    let mut cli = Cli {
        command: args.next().unwrap_or_else(|| "help".into()),
        ..Cli::default()
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => {
                cli.socket = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| "--socket requires a path".to_string())?,
                ));
            }
            "--database" => {
                cli.database = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| "--database requires a path".to_string())?,
                ));
            }
            "--json" => cli.json = true,
            "--name" => cli.name = Some(next_arg(&mut args, "--name")?),
            "--cwd" => cli.cwd = Some(next_arg(&mut args, "--cwd")?),
            "--pane" => cli.pane = Some(next_arg(&mut args, "--pane")?),
            "--file" => cli.file = Some(next_arg(&mut args, "--file")?),
            "--cols" => cli.cols = Some(parse_u16(&next_arg(&mut args, "--cols")?, "--cols")?),
            "--rows" => cli.rows = Some(parse_u16(&next_arg(&mut args, "--rows")?, "--rows")?),
            "--after" => {
                cli.after_seq = Some(parse_u64(&next_arg(&mut args, "--after")?, "--after")?)
            }
            "--timeout" => {
                cli.timeout_ms = Some(parse_u64(&next_arg(&mut args, "--timeout")?, "--timeout")?)
            }
            "--lease" => {
                cli.lease_epoch = Some(parse_u64(&next_arg(&mut args, "--lease")?, "--lease")?)
            }
            "--keep" => cli.keep = true,
            "--force" => cli.force = true,
            "--newline" => cli.newline = true,
            "--take-control" => cli.take_control = true,
            "--help" | "-h" => {
                let command = match (
                    cli.command.as_str(),
                    cli.positionals.first().map(String::as_str),
                ) {
                    ("workspace", Some("list")) => "workspaces".to_string(),
                    ("workspace", Some(subcommand)) => format!("workspace-{subcommand}"),
                    ("session", Some("list")) => "sessions".to_string(),
                    ("session", Some(subcommand)) => subcommand.to_string(),
                    _ => cli.command.clone(),
                };
                cli.command = "help".into();
                cli.positionals.clear();
                if command != "help" {
                    cli.positionals.push(command);
                }
            }
            "--" => {
                cli.positionals.extend(args);
                break;
            }
            _ if arg.starts_with("--") => return Err(format!("unknown argument: {arg}")),
            _ => cli.positionals.push(arg),
        }
    }
    normalize_grouped_command(&mut cli)?;
    Ok(cli)
}

#[cfg(unix)]
fn normalize_grouped_command(cli: &mut Cli) -> Result<(), String> {
    let group = cli.command.clone();
    if !matches!(group.as_str(), "workspace" | "session") {
        return Ok(());
    }
    let Some(subcommand) = cli.positionals.first().cloned() else {
        return Err(format!("usage: yterminal-agent {group} <COMMAND> [ARGS]"));
    };
    cli.positionals.remove(0);
    cli.command = match (group.as_str(), subcommand.as_str()) {
        ("workspace", "list") => "workspaces",
        ("workspace", "get") => "workspace-get",
        ("workspace", "create") => "workspace-create",
        ("workspace", "delete") => "workspace-delete",
        ("session", "list") => "sessions",
        ("session", "spawn") => "spawn",
        ("session", "attach") => "attach",
        ("session", "input") => "input",
        ("session", "input-line") => "input-line",
        ("session", "resize") => "resize",
        ("session", "kill") => "kill",
        _ => return Err(format!("unknown {group} command: {subcommand}")),
    }
    .into();
    Ok(())
}

#[cfg(unix)]
fn next_arg(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{flag} requires a value"))
}

#[cfg(unix)]
fn parse_u16(value: &str, flag: &str) -> Result<u16, String> {
    let parsed = value
        .parse::<u16>()
        .map_err(|_| format!("{flag} must be a positive integer"))?;
    if parsed == 0 {
        Err(format!("{flag} must be greater than zero"))
    } else {
        Ok(parsed)
    }
}

#[cfg(unix)]
fn parse_u64(value: &str, flag: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("{flag} must be a non-negative integer"))
}

#[cfg(unix)]
fn require_no_positionals(cli: &Cli) -> Result<(), String> {
    if cli.positionals.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{} does not accept positional arguments: {}",
            cli.command,
            cli.positionals.join(" ")
        ))
    }
}

#[cfg(unix)]
fn parse_drain_value(cli: &Cli) -> Result<bool, String> {
    match cli.positionals.as_slice() {
        [value] if matches!(value.as_str(), "on" | "true" | "1") => Ok(true),
        [value] if matches!(value.as_str(), "off" | "false" | "0") => Ok(false),
        _ => Err("usage: yterminal-agent drain on|off [--socket PATH]".into()),
    }
}

#[cfg(unix)]
async fn print_status(cli: &Cli) -> Result<(), String> {
    let service = if cli.socket.is_none() {
        Some(service::status().await?)
    } else {
        None
    };
    let runtime = match agent_request(cli, RequestBody::AgentStatus).await {
        Ok(ResponseBody::AgentStatus {
            draining,
            running_sessions,
            database_bytes,
            journal_bytes,
            checkpoint_bytes,
            dropped_journal_chunks,
        }) => Some(RuntimeStatus {
            draining,
            running_sessions,
            database_bytes,
            journal_bytes,
            checkpoint_bytes,
            dropped_journal_chunks,
        }),
        Ok(other) => return Err(format!("unexpected status response: {other:?}")),
        Err(_) if service.as_ref().is_some_and(|service| !service.running) => None,
        Err(error) => return Err(error),
    };
    if cli.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&StatusOutput {
                service,
                socket: cli
                    .socket
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                runtime,
            })
            .map_err(|error| error.to_string())?
        );
        return Ok(());
    }
    if let Some(service) = &service {
        print_service_status(service);
    } else if let Some(socket) = &cli.socket {
        println!("service: unmanaged custom socket");
        println!("socket: {}", socket.display());
    }
    if let Some(runtime) = runtime {
        println!(
            "runtime: draining={} liveSessions={} db={} journal={} checkpoints={} droppedJournalChunks={}",
            runtime.draining,
            runtime.running_sessions,
            format_bytes(runtime.database_bytes),
            format_bytes(runtime.journal_bytes),
            format_bytes(runtime.checkpoint_bytes),
            runtime.dropped_journal_chunks
        );
    } else {
        println!("runtime: offline");
    }
    Ok(())
}

#[cfg(unix)]
fn print_service_status(status: &AgentServiceStatus) {
    println!(
        "service: installed={} managed={} running={} version={}",
        status.installed,
        status.managed,
        status.running,
        status.version.as_deref().unwrap_or("unknown")
    );
    println!("binary: {}", status.binary_path);
    println!("service: {}", status.service_path);
}

#[cfg(unix)]
fn print_sessions(sessions: &[SessionInfo], json: bool) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(sessions).map_err(|error| error.to_string())?
        );
        return Ok(());
    }
    if sessions.is_empty() {
        println!("sessions: none");
        return Ok(());
    }
    for session in sessions {
        println!(
            "{} pane={} workspace={} state={:?} pid={} cwd={} size={}x{} headSeq={} exit={}",
            session.session_id,
            session.pane_id,
            session.workspace_id,
            session.state,
            session
                .pid
                .map(|pid| pid.to_string())
                .unwrap_or_else(|| "-".into()),
            session.cwd.as_deref().unwrap_or("-"),
            session.cols,
            session.rows,
            session.head_seq,
            session
                .exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "-".into())
        );
    }
    Ok(())
}

#[cfg(unix)]
async fn print_workspaces(cli: &Cli) -> Result<(), String> {
    match agent_request(cli, RequestBody::ListWorkspaces).await? {
        ResponseBody::Workspaces { workspaces } => {
            if cli.json {
                print_json(&workspaces)
            } else {
                if workspaces.is_empty() {
                    println!("workspaces: none");
                    return Ok(());
                }
                for workspace in workspaces {
                    println!(
                        "{} revision={} tabs={} name={}",
                        workspace.id,
                        workspace.revision,
                        workspace.tabs.len(),
                        workspace.name
                    );
                }
                Ok(())
            }
        }
        other => Err(format!("unexpected workspaces response: {other:?}")),
    }
}

#[cfg(unix)]
async fn print_workspace_get(cli: &Cli) -> Result<(), String> {
    let workspace_id = one_positional(cli, "usage: yterminal-agent workspace-get WORKSPACE_ID")?;
    match agent_request(
        cli,
        RequestBody::GetWorkspace {
            workspace_id: workspace_id.to_string(),
        },
    )
    .await?
    {
        ResponseBody::Workspace { workspace } => {
            if cli.json {
                print_json(&workspace)
            } else {
                println!(
                    "{} revision={} tabs={} name={}",
                    workspace.id,
                    workspace.revision,
                    workspace.tabs.len(),
                    workspace.name
                );
                for tab in &workspace.tabs {
                    let mut panes = Vec::new();
                    collect_leaf_ids(&tab.root, &mut panes);
                    println!(
                        "  tab={} panes={} cwd={} name={}",
                        tab.id,
                        panes.join(","),
                        tab.cwd,
                        tab.name
                    );
                }
                Ok(())
            }
        }
        other => Err(format!("unexpected workspace response: {other:?}")),
    }
}

#[cfg(unix)]
async fn create_workspace(cli: &Cli) -> Result<(), String> {
    require_no_positionals(cli)?;
    let cwd = default_cwd(cli)?;
    let workspace_id = new_id("ws");
    let tab_id = new_id("tab");
    let pane_id = new_id("pane");
    let workspace = WorkspaceDocument {
        id: workspace_id.clone(),
        revision: 0,
        name: cli.name.clone().unwrap_or_else(|| "CLI workspace".into()),
        icon: None,
        tabs: vec![TabDocument {
            id: tab_id.clone(),
            name: "shell".into(),
            custom_name: None,
            icon: None,
            cwd: cwd.clone(),
            root: PaneTree::Leaf {
                id: pane_id.clone(),
                cwd: cwd.clone(),
                session_id: None,
                agent: None,
                runtime_status: None,
                runtime_title: None,
            },
            file: None,
        }],
    };
    match agent_request(cli, RequestBody::CreateWorkspace { workspace }).await? {
        ResponseBody::Workspace { workspace } => {
            let output = WorkspaceCreatedOutput {
                workspace_id,
                tab_id,
                pane_id,
                revision: workspace.revision,
                cwd,
            };
            if cli.json {
                print_json(&output)
            } else {
                println!(
                    "workspace={} tab={} pane={} revision={} cwd={}",
                    output.workspace_id, output.tab_id, output.pane_id, output.revision, output.cwd
                );
                Ok(())
            }
        }
        other => Err(format!("unexpected create response: {other:?}")),
    }
}

#[cfg(unix)]
async fn delete_workspace(cli: &Cli) -> Result<(), String> {
    let workspace_id = one_positional(cli, "usage: yterminal-agent workspace-delete WORKSPACE_ID")?;
    let conn = connect_agent(cli, "yterminal-agent cli").await?;
    let lease_epoch = acquire_control(&conn, workspace_id, true).await?;
    match conn
        .request(RequestBody::DeleteWorkspace {
            workspace_id: workspace_id.to_string(),
            lease_epoch,
        })
        .await?
    {
        ResponseBody::Ack => {
            println!("deleted workspace={workspace_id}");
            Ok(())
        }
        other => Err(format!("unexpected delete response: {other:?}")),
    }
}

#[cfg(unix)]
async fn acquire_control_command(cli: &Cli) -> Result<(), String> {
    let workspace_id =
        one_positional(cli, "usage: yterminal-agent control WORKSPACE_ID [--force]")?;
    let conn = connect_agent(cli, "yterminal-agent cli").await?;
    let lease_epoch = acquire_control(&conn, workspace_id, cli.force).await?;
    let output = ControlOutput {
        workspace_id: workspace_id.to_string(),
        lease_epoch,
        released_on_exit: true,
    };
    if cli.json {
        print_json(&output)
    } else {
        println!(
            "workspace={} lease={} (released when this command exits; use control-hold to retain it)",
            output.workspace_id, output.lease_epoch
        );
        Ok(())
    }
}

#[cfg(unix)]
async fn hold_control_command(cli: &Cli) -> Result<(), String> {
    let workspace_id = one_positional(
        cli,
        "usage: yterminal-agent control-hold WORKSPACE_ID [--force] [--timeout MS] [--json]",
    )?;
    let conn = connect_agent(cli, "yterminal-agent control hold").await?;
    let lease_epoch = acquire_control(&conn, workspace_id, cli.force).await?;
    let held_ms = cli.timeout_ms.unwrap_or(30_000);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(held_ms);
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The first interval tick fires immediately; the acquire itself is fresh.
    interval.tick().await;
    let mut heartbeats = 0u64;
    while tokio::time::Instant::now() < deadline {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            _ = interval.tick() => {
                match conn.request(RequestBody::ControlHeartbeat {
                    workspace_id: workspace_id.to_string(),
                    lease_epoch,
                }).await? {
                    ResponseBody::Ack => heartbeats += 1,
                    other => return Err(format!("unexpected heartbeat response: {other:?}")),
                }
            }
        }
    }
    let released = matches!(
        conn.request(RequestBody::ReleaseControl {
            workspace_id: workspace_id.to_string(),
            lease_epoch,
        })
        .await,
        Ok(ResponseBody::Ack)
    );
    let output = ControlHoldOutput {
        workspace_id: workspace_id.to_string(),
        lease_epoch,
        held_ms,
        heartbeats,
        released,
    };
    if cli.json {
        print_json(&output)?;
    } else {
        println!(
            "workspace={} lease={} heldMs={} heartbeats={} released={}",
            output.workspace_id,
            output.lease_epoch,
            output.held_ms,
            output.heartbeats,
            output.released
        );
    }
    if released {
        Ok(())
    } else {
        Err("control lease was lost before release".into())
    }
}

#[cfg(unix)]
async fn spawn_command(cli: &Cli) -> Result<(), String> {
    if cli.positionals.is_empty() {
        return Err(
            "usage: yterminal-agent spawn WORKSPACE_ID [--pane PANE_ID] [--file PATH] [--cwd PATH] [--cols N] [--rows N] [-- ARG ...]"
                .into(),
        );
    }
    let workspace_id = &cli.positionals[0];
    let args = cli.positionals[1..].to_vec();
    let conn = connect_agent(cli, "yterminal-agent cli").await?;
    let workspace = get_workspace(&conn, workspace_id).await?;
    let pane_id = cli
        .pane
        .clone()
        .or_else(|| first_pane_id(&workspace))
        .ok_or_else(|| format!("workspace has no pane: {workspace_id}"))?;
    let lease_epoch = acquire_control(&conn, workspace_id, true).await?;
    let cwd = cli
        .cwd
        .clone()
        .or_else(|| workspace.cwd_for_pane(&pane_id))
        .or_else(|| Some(default_cwd(cli).unwrap_or_else(|_| ".".into())));
    let file = cli.file.clone().unwrap_or_default();
    let cols = cli.cols.unwrap_or(120);
    let rows = cli.rows.unwrap_or(30);
    match conn
        .request(RequestBody::SpawnSession {
            workspace_id: workspace_id.to_string(),
            pane_id: pane_id.clone(),
            lease_epoch,
            file,
            args,
            cols,
            rows,
            cwd,
            env: BTreeMap::new(),
        })
        .await?
    {
        ResponseBody::SessionSpawned { session_id, pid } => {
            let output = SpawnOutput {
                workspace_id: workspace_id.to_string(),
                pane_id,
                session_id,
                pid,
                lease_epoch,
            };
            if cli.json {
                print_json(&output)
            } else {
                println!(
                    "session={} pid={} workspace={} pane={} lease={}",
                    output.session_id,
                    output
                        .pid
                        .map(|pid| pid.to_string())
                        .unwrap_or_else(|| "-".into()),
                    output.workspace_id,
                    output.pane_id,
                    output.lease_epoch
                );
                Ok(())
            }
        }
        other => Err(format!("unexpected spawn response: {other:?}")),
    }
}

#[cfg(unix)]
async fn attach_command(cli: &Cli) -> Result<(), String> {
    let session_id = one_positional(
        cli,
        "usage: yterminal-agent attach SESSION_ID [--after SEQ] [--cols N] [--rows N] [--timeout MS]",
    )?;
    let mut conn = connect_agent(cli, "yterminal-agent cli").await?;
    let control = if cli.take_control {
        let session = find_session(&conn, session_id).await?;
        let lease_epoch = acquire_control(&conn, &session.workspace_id, true).await?;
        Some((session.workspace_id, lease_epoch))
    } else {
        None
    };
    attach_session(&conn, session_id, cli.after_seq, cli.cols, cli.rows).await?;
    let timeout = Duration::from_millis(cli.timeout_ms.unwrap_or(2_000));
    stream_session_output(&mut conn, session_id, timeout, control.as_ref()).await?;
    let _ = conn
        .request(RequestBody::DetachSession {
            session_id: session_id.to_string(),
        })
        .await;
    if let Some((workspace_id, lease_epoch)) = control {
        let _ = conn
            .request(RequestBody::ReleaseControl {
                workspace_id,
                lease_epoch,
            })
            .await;
    }
    Ok(())
}

#[cfg(unix)]
async fn input_command(cli: &Cli, force_newline: bool) -> Result<(), String> {
    reject_reused_cli_lease(cli)?;
    if cli.positionals.is_empty() {
        return Err("usage: yterminal-agent input SESSION_ID [TEXT] [--newline]".into());
    }
    let session_id = &cli.positionals[0];
    let mut bytes = if cli.positionals.len() > 1 {
        cli.positionals[1..].join(" ").into_bytes()
    } else {
        let mut bytes = Vec::new();
        io::stdin()
            .read_to_end(&mut bytes)
            .map_err(|error| format!("read stdin: {error}"))?;
        bytes
    };
    if force_newline || cli.newline {
        bytes.push(b'\n');
    }
    let conn = connect_agent(cli, "yterminal-agent cli").await?;
    let lease_epoch = match cli.lease_epoch {
        Some(lease) => lease,
        None => {
            let session = find_session(&conn, session_id).await?;
            acquire_control(&conn, &session.workspace_id, true).await?
        }
    };
    match conn
        .request(RequestBody::Input {
            session_id: session_id.to_string(),
            lease_epoch,
            bytes: ByteBuf::from(bytes),
        })
        .await?
    {
        ResponseBody::Ack => {
            println!("input sent session={session_id}");
            Ok(())
        }
        other => Err(format!("unexpected input response: {other:?}")),
    }
}

#[cfg(unix)]
async fn resize_command(cli: &Cli) -> Result<(), String> {
    reject_reused_cli_lease(cli)?;
    let session_id = one_positional(
        cli,
        "usage: yterminal-agent resize SESSION_ID --cols N --rows N",
    )?;
    let cols = cli.cols.ok_or_else(|| "--cols is required".to_string())?;
    let rows = cli.rows.ok_or_else(|| "--rows is required".to_string())?;
    let conn = connect_agent(cli, "yterminal-agent cli").await?;
    let lease_epoch = match cli.lease_epoch {
        Some(lease) => lease,
        None => {
            let session = find_session(&conn, session_id).await?;
            acquire_control(&conn, &session.workspace_id, true).await?
        }
    };
    match conn
        .request(RequestBody::Resize {
            session_id: session_id.to_string(),
            lease_epoch,
            cols,
            rows,
        })
        .await?
    {
        ResponseBody::Ack => {
            println!("resized session={session_id} size={}x{}", cols, rows);
            Ok(())
        }
        other => Err(format!("unexpected resize response: {other:?}")),
    }
}

#[cfg(unix)]
async fn kill_command(cli: &Cli) -> Result<(), String> {
    reject_reused_cli_lease(cli)?;
    let session_id = one_positional(cli, "usage: yterminal-agent kill SESSION_ID")?;
    let conn = connect_agent(cli, "yterminal-agent cli").await?;
    let lease_epoch = match cli.lease_epoch {
        Some(lease) => lease,
        None => {
            let session = find_session(&conn, session_id).await?;
            acquire_control(&conn, &session.workspace_id, true).await?
        }
    };
    match conn
        .request(RequestBody::KillSession {
            session_id: session_id.to_string(),
            lease_epoch,
        })
        .await?
    {
        ResponseBody::Ack => {
            println!("killed session={session_id}");
            Ok(())
        }
        other => Err(format!("unexpected kill response: {other:?}")),
    }
}

#[cfg(unix)]
async fn smoke_command(cli: &Cli) -> Result<(), String> {
    require_no_positionals(cli)?;
    let mut conn = connect_agent(cli, "yterminal-agent smoke").await?;
    let cwd = default_cwd(cli)?;
    let workspace_id = new_id("ws");
    let tab_id = new_id("tab");
    let pane_id = new_id("pane");
    let marker = format!("YT_AGENT_SMOKE_{}", Uuid::new_v4().simple());
    let workspace = WorkspaceDocument {
        id: workspace_id.clone(),
        revision: 0,
        name: cli.name.clone().unwrap_or_else(|| "CLI smoke".into()),
        icon: None,
        tabs: vec![TabDocument {
            id: tab_id,
            name: "smoke".into(),
            custom_name: None,
            icon: None,
            cwd: cwd.clone(),
            root: PaneTree::Leaf {
                id: pane_id.clone(),
                cwd: cwd.clone(),
                session_id: None,
                agent: None,
                runtime_status: None,
                runtime_title: None,
            },
            file: None,
        }],
    };
    match conn
        .request(RequestBody::CreateWorkspace { workspace })
        .await?
    {
        ResponseBody::Workspace { .. } => {}
        other => return Err(format!("unexpected create response: {other:?}")),
    }
    let lease_epoch = acquire_control(&conn, &workspace_id, true).await?;
    let (session_id, _) = match conn
        .request(RequestBody::SpawnSession {
            workspace_id: workspace_id.clone(),
            pane_id: pane_id.clone(),
            lease_epoch,
            file: cli.file.clone().unwrap_or_default(),
            args: Vec::new(),
            cols: cli.cols.unwrap_or(120),
            rows: cli.rows.unwrap_or(30),
            cwd: Some(cwd),
            env: BTreeMap::new(),
        })
        .await?
    {
        ResponseBody::SessionSpawned { session_id, pid } => (session_id, pid),
        other => return Err(format!("unexpected spawn response: {other:?}")),
    };
    attach_session(&conn, &session_id, None, cli.cols, cli.rows).await?;
    let command = format!("printf '{}\\n'; exit 0\n", shell_single_quote(&marker));
    conn.request(RequestBody::Input {
        session_id: session_id.clone(),
        lease_epoch,
        bytes: ByteBuf::from(command.into_bytes()),
    })
    .await?;
    let timeout = Duration::from_millis(cli.timeout_ms.unwrap_or(10_000));
    let (observed_marker, exit_code) =
        wait_for_session_marker(&mut conn, &session_id, &marker, timeout).await?;
    let mut cleaned_up = false;
    if !cli.keep {
        cleaned_up = matches!(
            conn.request(RequestBody::DeleteWorkspace {
                workspace_id: workspace_id.clone(),
                lease_epoch,
            })
            .await,
            Ok(ResponseBody::Ack)
        );
    }
    let output = SmokeOutput {
        workspace_id,
        pane_id,
        session_id,
        marker,
        observed_marker,
        exit_code,
        cleaned_up,
    };
    if cli.json {
        print_json(&output)?;
    } else {
        println!(
            "smoke marker={} observed={} exit={} cleanedUp={} workspace={} session={}",
            output.marker,
            output.observed_marker,
            output
                .exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "-".into()),
            output.cleaned_up,
            output.workspace_id,
            output.session_id
        );
    }
    if observed_marker && exit_code == Some(0) && (cli.keep || cleaned_up) {
        Ok(())
    } else {
        Err("smoke test failed".into())
    }
}

/// The scrollback-preserving upgrade path. Unlike `restart` (which loses live
/// shells and their scrollback because a respawned session starts empty) and
/// `shutdown` (blocked while any session is live), `hot-restart` restarts the
/// managed daemon with sessions present and relies on pane checkpoint
/// inheritance so respawned panes replay their prior scrollback. The frontend's
/// existing reconnect/reattach logic then recovers structure and re-spawns.
#[cfg(unix)]
async fn hot_restart_command(cli: &Cli) -> Result<(), String> {
    require_no_positionals(cli)?;
    if cli.socket.is_some() {
        return Err(
            "hot-restart manages the installed system service and cannot target a custom \
             --socket daemon; restart that daemon process directly"
                .into(),
        );
    }
    let timeout = Duration::from_millis(cli.timeout_ms.unwrap_or(30_000));

    // Probe the running daemon: capture its version and live session count so
    // the report shows what was preserved. A daemon that is not running is a
    // hard error — there is nothing to hot-restart.
    let (version_before, sessions_before) = probe_agent(cli)
        .await
        .map_err(|error| format!("hot-restart requires a running agent: {error}"))?;

    service::restart().await?;

    // Wait for the freshly started daemon to accept connections, then re-probe.
    let deadline = tokio::time::Instant::now() + timeout;
    let (version_after, sessions_after) = loop {
        match probe_agent(cli).await {
            Ok(result) => break result,
            Err(error) => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(format!(
                        "agent did not become ready within {}ms after hot-restart: {error}",
                        timeout.as_millis()
                    ));
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    };

    let output = HotRestartOutput {
        restarted: true,
        version_before,
        version_after,
        sessions_before,
        sessions_after,
    };
    if cli.json {
        print_json(&output)?;
    } else {
        println!(
            "hot-restart ok versionBefore={} versionAfter={} sessionsBefore={} sessionsAfter={}",
            output.version_before,
            output.version_after,
            output.sessions_before,
            output.sessions_after
        );
    }
    Ok(())
}

/// Connect once, returning the handshake-reported agent version and the current
/// live session count. Used to bracket a hot-restart.
#[cfg(unix)]
async fn probe_agent(cli: &Cli) -> Result<(String, usize), String> {
    let conn = connect_agent(cli, "yterminal-agent hot-restart").await?;
    let version = conn.client.hello.agent_version.clone();
    let sessions = match conn.request(RequestBody::ListSessions).await? {
        ResponseBody::Sessions { sessions } => sessions.len(),
        other => return Err(format!("unexpected sessions response: {other:?}")),
    };
    Ok((version, sessions))
}

#[cfg(unix)]
async fn verify_command(cli: &Cli) -> Result<(), String> {
    require_no_positionals(cli)?;
    if cli.keep {
        return Err(
            "verify does not support --keep; its isolation guarantee requires cleanup".into(),
        );
    }
    let suffix = Uuid::new_v4().simple().to_string();
    let workspace_id = format!("verify-ws-{suffix}");
    let imported_workspace_id = format!("verify-import-{suffix}");
    let fixture_dir = std::env::temp_dir().join(format!("yterminal-agent-verify-{suffix}"));
    let result =
        run_protocol_verify(cli, &workspace_id, &imported_workspace_id, &fixture_dir).await;

    let main = cleanup_verify_workspace(cli, &workspace_id).await;
    let imported = cleanup_verify_workspace(cli, &imported_workspace_id).await;
    let cleaned_up = main && imported;
    let _ = std::fs::remove_dir_all(&fixture_dir);

    match result {
        Ok(mut output) => {
            output.cleaned_up = cleaned_up;
            if cli.json {
                print_json(&output)?;
            } else {
                println!(
                    "verify checks={} leases={:?} cleanedUp={} workspace={} session={}",
                    output.checks.len(),
                    output.lease_epochs,
                    output.cleaned_up,
                    output.workspace_id,
                    output.session_id
                );
                for check in &output.checks {
                    println!("  ok {check}");
                }
            }
            if cleaned_up {
                Ok(())
            } else {
                Err("protocol verification passed but cleanup failed".into())
            }
        }
        Err(error) => Err(format!(
            "protocol verification failed: {error}; cleanedUp={cleaned_up}"
        )),
    }
}

#[cfg(unix)]
async fn run_protocol_verify(
    cli: &Cli,
    workspace_id: &str,
    imported_workspace_id: &str,
    fixture_dir: &std::path::Path,
) -> Result<VerifyOutput, String> {
    prepare_verify_fixture(fixture_dir)?;
    let cwd = fixture_dir.to_string_lossy().into_owned();
    let file_path = fixture_dir
        .join("fixture.txt")
        .to_string_lossy()
        .into_owned();
    let mut owner = connect_agent(cli, "yterminal-agent verify owner").await?;
    let mut controller = connect_agent(cli, "yterminal-agent verify controller").await?;
    let mut checks = Vec::new();

    expect_response(
        owner.request(RequestBody::Ping).await?,
        "pong",
        |response| matches!(response, ResponseBody::Pong),
    )?;
    checks.push("ping".into());
    expect_response(
        owner.request(RequestBody::AgentStatus).await?,
        "agent_status",
        |response| matches!(response, ResponseBody::AgentStatus { .. }),
    )?;
    checks.push("agent-status".into());
    expect_response(
        owner.request(RequestBody::HomeDir).await?,
        "home_directory",
        |response| matches!(response, ResponseBody::HomeDirectory { path: Some(_) }),
    )?;
    checks.push("home-dir".into());

    let imported_pane_id = format!("import-pane-{workspace_id}");
    let imported = make_verify_workspace(
        imported_workspace_id,
        &format!("import-tab-{workspace_id}"),
        &imported_pane_id,
        &cwd,
        "CLI verify import",
    );
    let imported_list = owner
        .request(RequestBody::ImportWorkspaces {
            workspaces: vec![imported],
        })
        .await?;
    expect_response(
        imported_list,
        "import_workspaces",
        |response| match response {
            ResponseBody::Workspaces { workspaces } => workspaces
                .iter()
                .any(|workspace| workspace.id == imported_workspace_id),
            _ => false,
        },
    )?;
    checks.push("workspace-import".into());

    let tab_id = format!("verify-tab-{workspace_id}");
    let pane_id = format!("verify-pane-{workspace_id}");
    let workspace = make_verify_workspace(workspace_id, &tab_id, &pane_id, &cwd, "CLI verify");
    let mut workspace = match owner
        .request(RequestBody::CreateWorkspace { workspace })
        .await?
    {
        ResponseBody::Workspace { workspace } => workspace,
        other => return Err(format!("unexpected create response: {other:?}")),
    };
    if workspace.revision != 1 {
        return Err(format!("initial revision was {}", workspace.revision));
    }
    checks.push("workspace-create".into());
    expect_response(
        owner.request(RequestBody::ListWorkspaces).await?,
        "list_workspaces",
        |response| match response {
            ResponseBody::Workspaces { workspaces } => workspaces
                .iter()
                .any(|workspace| workspace.id == workspace_id),
            _ => false,
        },
    )?;
    let fetched = get_workspace(&owner, workspace_id).await?;
    if fetched.revision != workspace.revision {
        return Err("workspace get returned a different revision".into());
    }
    checks.push("workspace-list-get".into());

    let lease_a = acquire_control(&owner, workspace_id, true).await?;
    expect_ack(
        owner
            .request(RequestBody::ControlHeartbeat {
                workspace_id: workspace_id.to_string(),
                lease_epoch: lease_a,
            })
            .await?,
        "initial heartbeat",
    )?;
    checks.push("control-acquire-heartbeat".into());

    let second_tab_id = format!("verify-tab-2-{workspace_id}");
    let second_pane_id = format!("verify-pane-2-{workspace_id}");
    let split_id = format!("verify-split-{workspace_id}");
    let split_pane_id = format!("verify-split-pane-{workspace_id}");
    let operations = vec![
        WorkspaceOperation::RenameWorkspace {
            name: "CLI verify renamed".into(),
        },
        WorkspaceOperation::SetWorkspaceIcon {
            icon: Some("V".into()),
        },
        WorkspaceOperation::AddTab {
            tab: TabDocument {
                id: second_tab_id.clone(),
                name: "second".into(),
                custom_name: None,
                icon: None,
                cwd: cwd.clone(),
                root: PaneTree::Leaf {
                    id: second_pane_id.clone(),
                    cwd: cwd.clone(),
                    session_id: None,
                    agent: None,
                    runtime_status: None,
                    runtime_title: None,
                },
                file: None,
            },
            index: None,
        },
        WorkspaceOperation::ReorderTab {
            tab_id: second_tab_id.clone(),
            index: 0,
        },
        WorkspaceOperation::RenameTab {
            tab_id: second_tab_id.clone(),
            name: "custom second".into(),
        },
        WorkspaceOperation::ClearTabCustomName {
            tab_id: second_tab_id.clone(),
        },
        WorkspaceOperation::SetTabAutoName {
            tab_id: second_tab_id.clone(),
            name: "auto second".into(),
        },
        WorkspaceOperation::SetTabIcon {
            tab_id: second_tab_id.clone(),
            icon: Some("T".into()),
        },
        WorkspaceOperation::SplitPane {
            tab_id: tab_id.clone(),
            target_pane_id: pane_id.clone(),
            split_id: split_id.clone(),
            new_pane_id: split_pane_id.clone(),
            direction: SplitDirection::Row,
            cwd: cwd.clone(),
        },
        WorkspaceOperation::SetSplitSizes {
            tab_id: tab_id.clone(),
            split_id: split_id.clone(),
            sizes: vec![40.0, 60.0],
        },
        WorkspaceOperation::UpdatePaneCwd {
            tab_id: tab_id.clone(),
            pane_id: pane_id.clone(),
            cwd: fixture_dir.join("nested").to_string_lossy().into_owned(),
        },
        WorkspaceOperation::SetPaneAgent {
            pane_id: pane_id.clone(),
            agent: Some(PaneAgentSummary {
                kind: "codex".into(),
                command: "codex-verify".into(),
                session_id: "verify-session".into(),
            }),
        },
        WorkspaceOperation::SetPaneRuntimeStatus {
            pane_id: pane_id.clone(),
            status: Some("working".into()),
        },
        WorkspaceOperation::SetPaneRuntimeTitle {
            pane_id: pane_id.clone(),
            title: Some("verifying".into()),
        },
        WorkspaceOperation::ClosePane {
            tab_id: tab_id.clone(),
            pane_id: split_pane_id,
        },
        WorkspaceOperation::RemoveTab {
            tab_id: second_tab_id,
        },
    ];
    for operation in operations {
        workspace =
            apply_verify_operation(&owner, workspace_id, workspace.revision, lease_a, operation)
                .await?;
    }
    if workspace.tabs.len() != 1 || workspace.tabs[0].id != tab_id {
        return Err("workspace operation projection did not return to one tab".into());
    }
    checks.push("all-workspace-operations".into());

    let stale_revision = workspace.revision.saturating_sub(1);
    expect_remote_error(
        owner
            .client
            .request(RequestBody::ApplyWorkspaceOp {
                workspace_id: workspace_id.to_string(),
                base_revision: stale_revision,
                lease_epoch: lease_a,
                operation: WorkspaceOperation::RenameWorkspace {
                    name: "must not apply".into(),
                },
            })
            .await,
        "workspace_revision_conflict",
        true,
    )?;
    checks.push("workspace-revision-conflict".into());

    expect_remote_error(
        controller
            .client
            .request(RequestBody::AcquireControl {
                workspace_id: workspace_id.to_string(),
                force: false,
            })
            .await,
        "control_held",
        true,
    )?;
    let lease_b = acquire_control(&controller, workspace_id, true).await?;
    if lease_b <= lease_a {
        return Err(format!("lease did not advance: {lease_a} -> {lease_b}"));
    }
    expect_remote_error(
        owner
            .client
            .request(RequestBody::ControlHeartbeat {
                workspace_id: workspace_id.to_string(),
                lease_epoch: lease_a,
            })
            .await,
        "stale_control_lease",
        false,
    )?;
    expect_ack(
        controller
            .request(RequestBody::ControlHeartbeat {
                workspace_id: workspace_id.to_string(),
                lease_epoch: lease_b,
            })
            .await?,
        "takeover heartbeat",
    )?;
    checks.push("control-takeover-stale-rejection".into());

    let marker = format!(
        "YT_VERIFY_MARKER_{suffix}",
        suffix = Uuid::new_v4().simple()
    );
    let replay_marker = format!(
        "YT_VERIFY_REPLAY_{suffix}",
        suffix = Uuid::new_v4().simple()
    );
    let (session_id, pid) = match controller
        .request(RequestBody::SpawnSession {
            workspace_id: workspace_id.to_string(),
            pane_id: pane_id.clone(),
            lease_epoch: lease_b,
            file: cli.file.clone().unwrap_or_else(|| "/bin/sh".into()),
            args: Vec::new(),
            cols: 80,
            rows: 24,
            cwd: Some(cwd.clone()),
            env: BTreeMap::new(),
        })
        .await?
    {
        ResponseBody::SessionSpawned { session_id, pid } => (session_id, pid),
        other => return Err(format!("unexpected spawn response: {other:?}")),
    };
    let bound = get_workspace(&owner, workspace_id).await?;
    if bound
        .tabs
        .iter()
        .find_map(|tab| session_for_pane(&tab.root, &pane_id))
        != Some(session_id.clone())
    {
        return Err("spawn did not bind the session into the workspace".into());
    }
    checks.push("spawn-session-bind".into());

    // A watcher may request a size but must not change the canonical grid.
    attach_session(&owner, &session_id, None, Some(91), Some(31)).await?;
    assert_session_size(&owner, &session_id, 80, 24).await?;
    // The current controller's attach establishes its own canonical grid.
    attach_session(&controller, &session_id, None, Some(101), Some(37)).await?;
    assert_session_size(&owner, &session_id, 101, 37).await?;
    checks.push("controller-only-attach-resize".into());

    let command = format!("printf '{}\\n'\n", shell_single_quote(&marker));
    expect_ack(
        controller
            .request(RequestBody::Input {
                session_id: session_id.clone(),
                lease_epoch: lease_b,
                bytes: ByteBuf::from(command.into_bytes()),
            })
            .await?,
        "marker input",
    )?;
    wait_for_output_text(
        &mut owner,
        &session_id,
        &marker,
        Duration::from_millis(cli.timeout_ms.unwrap_or(15_000)),
    )
    .await?;
    checks.push("attach-input-live-output".into());

    let actual_cwd = match owner
        .request(RequestBody::GetCwd {
            session_id: session_id.clone(),
        })
        .await?
    {
        ResponseBody::Cwd { cwd: Some(cwd) } => cwd,
        other => return Err(format!("unexpected cwd response: {other:?}")),
    };
    if std::fs::canonicalize(&actual_cwd).ok() != std::fs::canonicalize(fixture_dir).ok() {
        return Err(format!("session cwd mismatch: {actual_cwd} != {cwd}"));
    }
    expect_response(
        owner
            .request(RequestBody::ProcessTree {
                session_id: session_id.clone(),
            })
            .await?,
        "process_tree",
        |response| matches!(response, ResponseBody::Processes { .. }),
    )?;
    if let Some(pid) = pid {
        expect_response(
            owner
                .request(RequestBody::ResolveAgentSession {
                    kind: "verify-unknown".into(),
                    cwd: cwd.clone(),
                    pid,
                })
                .await?,
            "resolve_agent_session",
            |response| matches!(response, ResponseBody::AgentSession { session_id: None }),
        )?;
    }
    checks.push("cwd-process-agent-resolution".into());

    let git_status = owner
        .request(RequestBody::GitStatus { dir: cwd.clone() })
        .await?;
    expect_response(git_status, "git_status", |response| match response {
        ResponseBody::GitStatus { status } => {
            status.is_repo && status.files.iter().any(|file| file.path == "fixture.txt")
        }
        _ => false,
    })?;
    let git_diff = owner
        .request(RequestBody::GitDiff {
            dir: cwd.clone(),
            path: "fixture.txt".into(),
        })
        .await?;
    expect_response(git_diff, "git_diff", |response| match response {
        ResponseBody::Text { text } => text.contains("verify modified"),
        _ => false,
    })?;
    expect_response(
        owner
            .request(RequestBody::PathIsFile {
                path: file_path.clone(),
            })
            .await?,
        "path_is_file",
        |response| matches!(response, ResponseBody::Boolean { value: true }),
    )?;
    let first_chunk = owner
        .request(RequestBody::ReadTextFile {
            path: file_path.clone(),
            offset: 0,
            max_bytes: 8,
        })
        .await?;
    let (first_bytes, total_bytes) = match first_chunk {
        ResponseBody::FileChunk {
            bytes,
            total_bytes,
            eof: false,
        } => (bytes.into_vec(), total_bytes),
        other => return Err(format!("unexpected first file chunk: {other:?}")),
    };
    let second_chunk = owner
        .request(RequestBody::ReadTextFile {
            path: file_path,
            offset: first_bytes.len() as u64,
            max_bytes: 256 * 1024,
        })
        .await?;
    match second_chunk {
        ResponseBody::FileChunk {
            bytes,
            total_bytes: second_total,
            eof: true,
        } if second_total == total_bytes
            && first_bytes.len() + bytes.len() == total_bytes as usize => {}
        other => return Err(format!("unexpected final file chunk: {other:?}")),
    }
    checks.push("git-and-file-services".into());

    expect_ack(
        controller
            .request(RequestBody::Resize {
                session_id: session_id.clone(),
                lease_epoch: lease_b,
                cols: 111,
                rows: 39,
            })
            .await?,
        "resize",
    )?;
    assert_session_size(&owner, &session_id, 111, 39).await?;
    wait_for_size(&mut owner, &session_id, 111, 39, Duration::from_secs(3)).await?;
    checks.push("resize-broadcast".into());

    let head_seq = find_session(&owner, &session_id).await?.head_seq;
    let checkpoint_marker = format!("YT_VERIFY_CHECKPOINT_{}", Uuid::new_v4().simple());
    let checkpoint = format!("\u{1b}[2J\u{1b}[H{checkpoint_marker}\r\n").into_bytes();
    expect_ack(
        controller
            .request(RequestBody::CheckpointBegin {
                session_id: session_id.clone(),
                lease_epoch: lease_b,
                through_seq: head_seq,
                total_bytes: checkpoint.len() as u64,
            })
            .await?,
        "checkpoint begin",
    )?;
    let midpoint = checkpoint.len() / 2;
    for chunk in [&checkpoint[..midpoint], &checkpoint[midpoint..]] {
        expect_ack(
            controller
                .request(RequestBody::CheckpointChunk {
                    session_id: session_id.clone(),
                    bytes: ByteBuf::from(chunk.to_vec()),
                })
                .await?,
            "checkpoint chunk",
        )?;
    }
    expect_ack(
        controller
            .request(RequestBody::CheckpointEnd {
                session_id: session_id.clone(),
            })
            .await?,
        "checkpoint end",
    )?;
    let replay_command = format!("printf '{}\\n'\n", shell_single_quote(&replay_marker));
    expect_ack(
        controller
            .request(RequestBody::Input {
                session_id: session_id.clone(),
                lease_epoch: lease_b,
                bytes: ByteBuf::from(replay_command.into_bytes()),
            })
            .await?,
        "post-checkpoint input",
    )?;
    wait_for_output_text(
        &mut controller,
        &session_id,
        &replay_marker,
        Duration::from_secs(5),
    )
    .await?;
    let mut replayer = connect_agent(cli, "yterminal-agent verify replayer").await?;
    attach_session(&replayer, &session_id, None, None, None).await?;
    let replay = collect_replay(&mut replayer, &session_id, Duration::from_secs(5)).await?;
    if !replay.checkpoint.contains(&checkpoint_marker)
        || !replay.output.contains(&replay_marker)
        || replay.base_seq != head_seq
    {
        return Err(format!(
            "checkpoint replay mismatch base={} expected={} checkpoint={} output={}",
            replay.base_seq, head_seq, replay.checkpoint, replay.output
        ));
    }
    checks.push("checkpoint-and-journal-replay".into());

    let incremental_marker = format!("YT_VERIFY_INCREMENTAL_{}", Uuid::new_v4().simple());
    let after_seq = replay.next_seq;
    expect_ack(
        replayer
            .request(RequestBody::DetachSession {
                session_id: session_id.clone(),
            })
            .await?,
        "detach before incremental replay",
    )?;
    let incremental_command = format!("printf '{}\\n'\n", shell_single_quote(&incremental_marker));
    expect_ack(
        controller
            .request(RequestBody::Input {
                session_id: session_id.clone(),
                lease_epoch: lease_b,
                bytes: ByteBuf::from(incremental_command.into_bytes()),
            })
            .await?,
        "incremental input",
    )?;
    wait_for_output_text(
        &mut controller,
        &session_id,
        &incremental_marker,
        Duration::from_secs(5),
    )
    .await?;
    attach_session(&replayer, &session_id, Some(after_seq), None, None).await?;
    let incremental = collect_replay(&mut replayer, &session_id, Duration::from_secs(5)).await?;
    if incremental.reset
        || incremental.base_seq != after_seq
        || !incremental.output.contains(&incremental_marker)
    {
        return Err(
            "incremental replay did not resume exactly after the requested sequence".into(),
        );
    }
    checks.push("incremental-replay".into());

    expect_ack(
        controller
            .request(RequestBody::KillSession {
                session_id: session_id.clone(),
                lease_epoch: lease_b,
            })
            .await?,
        "kill",
    )?;
    wait_for_exit(&mut replayer, &session_id, Duration::from_secs(5)).await?;
    let killed = find_session(&owner, &session_id).await?;
    if !matches!(
        killed.state,
        yterminal::remote_protocol::SessionState::Exited
    ) {
        return Err("killed session was not marked exited".into());
    }
    checks.push("kill-and-exit".into());

    // Hot-restart inheritance: the killed session stands in for a shell that
    // died when the daemon restarted. Its checkpoint + post-checkpoint journal
    // remain on disk. A brand-new session spawned on the SAME pane must inherit
    // that scrollback so a fresh `after_seq=None` attach replays the prior
    // screen (checkpoint marker) plus the live tail (replay marker) before the
    // new shell's own output. This is the exact seam a hot-restart relies on.
    let (inherited_session_id, _) = match controller
        .request(RequestBody::SpawnSession {
            workspace_id: workspace_id.to_string(),
            pane_id: pane_id.clone(),
            lease_epoch: lease_b,
            file: cli.file.clone().unwrap_or_else(|| "/bin/sh".into()),
            args: Vec::new(),
            cols: 80,
            rows: 24,
            cwd: Some(cwd.clone()),
            env: BTreeMap::new(),
        })
        .await?
    {
        ResponseBody::SessionSpawned { session_id, pid } => (session_id, pid),
        other => return Err(format!("unexpected respawn response: {other:?}")),
    };
    if inherited_session_id == session_id {
        return Err("respawn reused the killed session id".into());
    }
    let mut inheritor = connect_agent(cli, "yterminal-agent verify inheritor").await?;
    attach_session(&inheritor, &inherited_session_id, None, None, None).await?;
    let inherited_replay =
        collect_replay(&mut inheritor, &inherited_session_id, Duration::from_secs(5)).await?;
    let inherited_text = format!("{}{}", inherited_replay.checkpoint, inherited_replay.output);
    if !inherited_replay.reset
        || !inherited_text.contains(&checkpoint_marker)
        || !inherited_text.contains(&replay_marker)
    {
        return Err(format!(
            "respawn did not inherit predecessor scrollback reset={} checkpoint_marker_present={} replay_marker_present={}",
            inherited_replay.reset,
            inherited_text.contains(&checkpoint_marker),
            inherited_text.contains(&replay_marker),
        ));
    }
    expect_ack(
        inheritor
            .request(RequestBody::DetachSession {
                session_id: inherited_session_id.clone(),
            })
            .await?,
        "detach inheritor",
    )?;
    expect_ack(
        controller
            .request(RequestBody::KillSession {
                session_id: inherited_session_id.clone(),
                lease_epoch: lease_b,
            })
            .await?,
        "kill inherited session",
    )?;
    checks.push("hot-restart-scrollback-inheritance".into());

    expect_ack(
        controller
            .request(RequestBody::ReleaseControl {
                workspace_id: workspace_id.to_string(),
                lease_epoch: lease_b,
            })
            .await?,
        "release control",
    )?;
    let lease_c = acquire_control(&owner, workspace_id, false).await?;
    if lease_c <= lease_b {
        return Err(format!(
            "lease did not advance after release: {lease_b} -> {lease_c}"
        ));
    }
    checks.push("control-release-reacquire".into());

    Ok(VerifyOutput {
        workspace_id: workspace_id.to_string(),
        imported_workspace_id: imported_workspace_id.to_string(),
        session_id,
        marker,
        replay_marker,
        checks,
        lease_epochs: vec![lease_a, lease_b, lease_c],
        cleaned_up: false,
    })
}

#[cfg(unix)]
fn make_verify_workspace(
    workspace_id: &str,
    tab_id: &str,
    pane_id: &str,
    cwd: &str,
    name: &str,
) -> WorkspaceDocument {
    WorkspaceDocument {
        id: workspace_id.to_string(),
        revision: 0,
        name: name.into(),
        icon: None,
        tabs: vec![TabDocument {
            id: tab_id.to_string(),
            name: "shell".into(),
            custom_name: None,
            icon: None,
            cwd: cwd.to_string(),
            root: PaneTree::Leaf {
                id: pane_id.to_string(),
                cwd: cwd.to_string(),
                session_id: None,
                agent: None,
                runtime_status: None,
                runtime_title: None,
            },
            file: None,
        }],
    }
}

#[cfg(unix)]
fn prepare_verify_fixture(dir: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|error| format!("create fixture: {error}"))?;
    std::fs::create_dir_all(dir.join("nested"))
        .map_err(|error| format!("create nested fixture: {error}"))?;
    let file = dir.join("fixture.txt");
    std::fs::write(&file, "verify initial\n").map_err(|error| format!("write fixture: {error}"))?;
    run_fixture_git(dir, &["init", "-q"])?;
    run_fixture_git(dir, &["add", "fixture.txt"])?;
    run_fixture_git(
        dir,
        &[
            "-c",
            "user.name=yterminal",
            "-c",
            "user.email=yterminal@example.invalid",
            "commit",
            "-q",
            "-m",
            "fixture",
        ],
    )?;
    std::fs::write(&file, "verify initial\nverify modified\n")
        .map_err(|error| format!("modify fixture: {error}"))
}

#[cfg(unix)]
fn run_fixture_git(dir: &std::path::Path, args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|error| format!("spawn fixture git: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "fixture git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

#[cfg(unix)]
async fn cleanup_verify_workspace(cli: &Cli, workspace_id: &str) -> bool {
    let Ok(conn) = connect_agent(cli, "yterminal-agent verify cleanup").await else {
        return false;
    };
    match conn
        .client
        .request(RequestBody::GetWorkspace {
            workspace_id: workspace_id.to_string(),
        })
        .await
    {
        Err(error) if error.code == "workspace_not_found" => true,
        Err(_) => false,
        Ok(ResponseBody::Workspace { .. }) => {
            let Ok(lease_epoch) = acquire_control(&conn, workspace_id, true).await else {
                return false;
            };
            matches!(
                conn.request(RequestBody::DeleteWorkspace {
                    workspace_id: workspace_id.to_string(),
                    lease_epoch,
                })
                .await,
                Ok(ResponseBody::Ack)
            )
        }
        Ok(_) => false,
    }
}

#[cfg(unix)]
async fn apply_verify_operation(
    conn: &AgentConnection,
    workspace_id: &str,
    base_revision: u64,
    lease_epoch: u64,
    operation: WorkspaceOperation,
) -> Result<WorkspaceDocument, String> {
    match conn
        .request(RequestBody::ApplyWorkspaceOp {
            workspace_id: workspace_id.to_string(),
            base_revision,
            lease_epoch,
            operation,
        })
        .await?
    {
        ResponseBody::Workspace { workspace } if workspace.revision > base_revision => {
            Ok(workspace)
        }
        ResponseBody::Workspace { workspace } => Err(format!(
            "workspace revision did not advance: {base_revision} -> {}",
            workspace.revision
        )),
        other => Err(format!(
            "unexpected workspace operation response: {other:?}"
        )),
    }
}

#[cfg(unix)]
fn expect_ack(response: ResponseBody, context: &str) -> Result<(), String> {
    if matches!(response, ResponseBody::Ack) {
        Ok(())
    } else {
        Err(format!("unexpected {context} response: {response:?}"))
    }
}

#[cfg(unix)]
fn expect_response(
    response: ResponseBody,
    context: &str,
    accept: impl FnOnce(&ResponseBody) -> bool,
) -> Result<(), String> {
    if accept(&response) {
        Ok(())
    } else {
        Err(format!("unexpected {context} response: {response:?}"))
    }
}

#[cfg(unix)]
fn expect_remote_error(
    result: Result<ResponseBody, RemoteError>,
    code: &str,
    retryable: bool,
) -> Result<(), String> {
    match result {
        Err(error) if error.code == code && error.retryable == retryable => Ok(()),
        Err(error) => Err(format!(
            "expected error {code} retryable={retryable}, got {} retryable={}: {}",
            error.code, error.retryable, error.message
        )),
        Ok(response) => Err(format!("expected error {code}, got {response:?}")),
    }
}

#[cfg(unix)]
fn session_for_pane(tree: &PaneTree, pane_id: &str) -> Option<String> {
    match tree {
        PaneTree::Leaf { id, session_id, .. } if id == pane_id => session_id.clone(),
        PaneTree::Leaf { .. } => None,
        PaneTree::Split { children, .. } => children
            .iter()
            .find_map(|child| session_for_pane(child, pane_id)),
    }
}

#[cfg(unix)]
async fn assert_session_size(
    conn: &AgentConnection,
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = find_session(conn, session_id).await?;
    if session.cols == cols && session.rows == rows {
        Ok(())
    } else {
        Err(format!(
            "session size mismatch: {}x{} != {cols}x{rows}",
            session.cols, session.rows
        ))
    }
}

#[cfg(unix)]
async fn wait_for_output_text(
    conn: &mut AgentConnection,
    session_id: &str,
    needle: &str,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut text = String::new();
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let event = tokio::time::timeout(remaining, conn.events_rx.recv())
            .await
            .map_err(|_| format!("timed out waiting for {needle}"))?
            .ok_or_else(|| "agent event stream closed".to_string())?;
        match event {
            AgentClientEvent::Message(EventBody::Output {
                session_id: event_session,
                bytes,
                ..
            })
            | AgentClientEvent::Message(EventBody::CheckpointChunk {
                session_id: event_session,
                bytes,
            }) if event_session == session_id => {
                text.push_str(&String::from_utf8_lossy(&bytes));
                if text.contains(needle) {
                    return Ok(());
                }
            }
            AgentClientEvent::Disconnected(message) => return Err(message),
            _ => {}
        }
    }
    Err(format!("timed out waiting for {needle}"))
}

#[cfg(unix)]
async fn wait_for_size(
    conn: &mut AgentConnection,
    session_id: &str,
    cols: u16,
    rows: u16,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let event = tokio::time::timeout(remaining, conn.events_rx.recv())
            .await
            .map_err(|_| "timed out waiting for size_changed".to_string())?
            .ok_or_else(|| "agent event stream closed".to_string())?;
        if matches!(
            event,
            AgentClientEvent::Message(EventBody::SizeChanged {
                session_id: ref event_session,
                cols: event_cols,
                rows: event_rows,
            }) if event_session == session_id && event_cols == cols && event_rows == rows
        ) {
            return Ok(());
        }
    }
    Err("timed out waiting for size_changed".into())
}

#[cfg(unix)]
struct ReplayCapture {
    reset: bool,
    base_seq: u64,
    next_seq: u64,
    checkpoint: String,
    output: String,
}

#[cfg(unix)]
async fn collect_replay(
    conn: &mut AgentConnection,
    session_id: &str,
    timeout: Duration,
) -> Result<ReplayCapture, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut reset = None;
    let mut base_seq = 0u64;
    let mut expected_seq = 0u64;
    let mut checkpoint = String::new();
    let mut output = String::new();
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let event = tokio::time::timeout(remaining, conn.events_rx.recv())
            .await
            .map_err(|_| "timed out collecting replay".to_string())?
            .ok_or_else(|| "agent event stream closed".to_string())?;
        match event {
            AgentClientEvent::Message(EventBody::ReplayBegin {
                session_id: event_session,
                reset: event_reset,
                base_seq: event_base,
                ..
            }) if event_session == session_id => {
                reset = Some(event_reset);
                base_seq = event_base;
                expected_seq = event_base;
            }
            AgentClientEvent::Message(EventBody::CheckpointChunk {
                session_id: event_session,
                bytes,
            }) if event_session == session_id => {
                checkpoint.push_str(&String::from_utf8_lossy(&bytes));
            }
            AgentClientEvent::Message(EventBody::Output {
                session_id: event_session,
                start_seq,
                bytes,
            }) if event_session == session_id => {
                if start_seq != expected_seq {
                    return Err(format!(
                        "replay sequence gap: expected {expected_seq}, got {start_seq}"
                    ));
                }
                expected_seq += bytes.len() as u64;
                output.push_str(&String::from_utf8_lossy(&bytes));
            }
            AgentClientEvent::Message(EventBody::ReplayEnd {
                session_id: event_session,
                next_seq,
            }) if event_session == session_id => {
                if next_seq != expected_seq {
                    return Err(format!(
                        "replay end mismatch: expected {expected_seq}, got {next_seq}"
                    ));
                }
                return Ok(ReplayCapture {
                    reset: reset.ok_or_else(|| "replay_end before replay_begin".to_string())?,
                    base_seq,
                    next_seq,
                    checkpoint,
                    output,
                });
            }
            AgentClientEvent::Disconnected(message) => return Err(message),
            _ => {}
        }
    }
    Err("timed out collecting replay".into())
}

#[cfg(unix)]
async fn wait_for_exit(
    conn: &mut AgentConnection,
    session_id: &str,
    timeout: Duration,
) -> Result<u32, String> {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let event = tokio::time::timeout(remaining, conn.events_rx.recv())
            .await
            .map_err(|_| "timed out waiting for exit".to_string())?
            .ok_or_else(|| "agent event stream closed".to_string())?;
        match event {
            AgentClientEvent::Message(EventBody::Exited {
                session_id: event_session,
                exit_code,
            }) if event_session == session_id => return Ok(exit_code),
            AgentClientEvent::Disconnected(message) => return Err(message),
            _ => {}
        }
    }
    Err("timed out waiting for exit".into())
}

#[cfg(unix)]
async fn agent_request(cli: &Cli, request: RequestBody) -> Result<ResponseBody, String> {
    let (events_tx, mut events_rx) = tokio::sync::mpsc::channel::<AgentClientEvent>(EVENT_CAPACITY);
    let _drain = tokio::spawn(async move { while events_rx.recv().await.is_some() {} });
    let client = match &cli.socket {
        Some(path) => {
            AgentClient::connect_local_path(path.clone(), "yterminal-agent cli", events_tx).await?
        }
        None => AgentClient::connect_local("yterminal-agent cli", events_tx).await?,
    };
    client.request(request).await.map_err(format_remote_error)
}

#[cfg(unix)]
async fn connect_agent(cli: &Cli, name: &str) -> Result<AgentConnection, String> {
    let (events_tx, events_rx) = tokio::sync::mpsc::channel::<AgentClientEvent>(EVENT_CAPACITY);
    let client = match &cli.socket {
        Some(path) => AgentClient::connect_local_path(path.clone(), name, events_tx).await?,
        None => AgentClient::connect_local(name, events_tx).await?,
    };
    Ok(AgentConnection { client, events_rx })
}

#[cfg(unix)]
impl AgentConnection {
    async fn request(&self, request: RequestBody) -> Result<ResponseBody, String> {
        self.client
            .request(request)
            .await
            .map_err(format_remote_error)
    }
}

#[cfg(unix)]
async fn acquire_control(
    conn: &AgentConnection,
    workspace_id: &str,
    force: bool,
) -> Result<u64, String> {
    match conn
        .request(RequestBody::AcquireControl {
            workspace_id: workspace_id.to_string(),
            force,
        })
        .await?
    {
        ResponseBody::ControlAcquired { lease_epoch, .. } => Ok(lease_epoch),
        other => Err(format!("unexpected control response: {other:?}")),
    }
}

#[cfg(unix)]
async fn get_workspace(
    conn: &AgentConnection,
    workspace_id: &str,
) -> Result<WorkspaceDocument, String> {
    match conn
        .request(RequestBody::GetWorkspace {
            workspace_id: workspace_id.to_string(),
        })
        .await?
    {
        ResponseBody::Workspace { workspace } => Ok(workspace),
        other => Err(format!("unexpected workspace response: {other:?}")),
    }
}

#[cfg(unix)]
async fn find_session(conn: &AgentConnection, session_id: &str) -> Result<SessionInfo, String> {
    match conn.request(RequestBody::ListSessions).await? {
        ResponseBody::Sessions { sessions } => sessions
            .into_iter()
            .find(|session| session.session_id == session_id)
            .ok_or_else(|| format!("session not found: {session_id}")),
        other => Err(format!("unexpected sessions response: {other:?}")),
    }
}

#[cfg(unix)]
async fn attach_session(
    conn: &AgentConnection,
    session_id: &str,
    after_seq: Option<u64>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<(), String> {
    match conn
        .request(RequestBody::AttachSession {
            session_id: session_id.to_string(),
            after_seq,
            cols: cols.unwrap_or(120),
            rows: rows.unwrap_or(30),
        })
        .await?
    {
        ResponseBody::Ack => Ok(()),
        other => Err(format!("unexpected attach response: {other:?}")),
    }
}

#[cfg(unix)]
async fn stream_session_output(
    conn: &mut AgentConnection,
    session_id: &str,
    timeout: Duration,
    control: Option<&(String, u64)>,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let heartbeat_client = conn.client.clone();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await;
    loop {
        let event = if timeout.is_zero() {
            if let Some((workspace_id, lease_epoch)) = control {
                tokio::select! {
                    event = conn.events_rx.recv() => event,
                    _ = heartbeat.tick() => {
                        heartbeat_client.request(RequestBody::ControlHeartbeat {
                            workspace_id: workspace_id.clone(),
                            lease_epoch: *lease_epoch,
                        }).await.map_err(format_remote_error)?;
                        continue;
                    }
                }
            } else {
                conn.events_rx.recv().await
            }
        } else {
            let now = Instant::now();
            if now >= deadline {
                return Ok(());
            }
            tokio::select! {
                event = conn.events_rx.recv() => event,
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => return Ok(()),
                _ = heartbeat.tick(), if control.is_some() => {
                    let (workspace_id, lease_epoch) = control.expect("guarded by select condition");
                    heartbeat_client.request(RequestBody::ControlHeartbeat {
                        workspace_id: workspace_id.clone(),
                        lease_epoch: *lease_epoch,
                    }).await.map_err(format_remote_error)?;
                    continue;
                }
            }
        };
        let Some(event) = event else {
            return Ok(());
        };
        match event {
            AgentClientEvent::Message(EventBody::Output {
                session_id: event_session,
                bytes,
                ..
            })
            | AgentClientEvent::Message(EventBody::CheckpointChunk {
                session_id: event_session,
                bytes,
            }) if event_session == session_id => {
                io::stdout()
                    .write_all(&bytes)
                    .map_err(|error| format!("write stdout: {error}"))?;
                io::stdout()
                    .flush()
                    .map_err(|error| format!("flush stdout: {error}"))?;
            }
            AgentClientEvent::Message(EventBody::Exited {
                session_id: event_session,
                ..
            }) if event_session == session_id => return Ok(()),
            AgentClientEvent::Diagnostic(message) => eprintln!("{message}"),
            AgentClientEvent::Disconnected(message) => return Err(message),
            _ => {}
        }
    }
}

#[cfg(unix)]
async fn wait_for_session_marker(
    conn: &mut AgentConnection,
    session_id: &str,
    marker: &str,
    timeout: Duration,
) -> Result<(bool, Option<u32>), String> {
    let deadline = Instant::now() + timeout;
    let mut text = String::new();
    let mut observed = false;
    let mut exit_code = None;
    loop {
        if observed && exit_code.is_some() {
            return Ok((true, exit_code));
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok((observed, exit_code));
        }
        let event = match tokio::time::timeout(deadline - now, conn.events_rx.recv()).await {
            Ok(event) => event,
            Err(_) => return Ok((observed, exit_code)),
        };
        let Some(event) = event else {
            return Ok((observed, exit_code));
        };
        match event {
            AgentClientEvent::Message(EventBody::Output {
                session_id: event_session,
                bytes,
                ..
            })
            | AgentClientEvent::Message(EventBody::CheckpointChunk {
                session_id: event_session,
                bytes,
            }) if event_session == session_id => {
                text.push_str(&String::from_utf8_lossy(&bytes));
                if text.contains(marker) {
                    observed = true;
                }
            }
            AgentClientEvent::Message(EventBody::Exited {
                session_id: event_session,
                exit_code: code,
            }) if event_session == session_id => exit_code = Some(code),
            AgentClientEvent::Diagnostic(message) => eprintln!("{message}"),
            AgentClientEvent::Disconnected(message) => return Err(message),
            _ => {}
        }
    }
}

#[cfg(unix)]
fn one_positional<'a>(cli: &'a Cli, usage: &str) -> Result<&'a str, String> {
    match cli.positionals.as_slice() {
        [value] => Ok(value),
        _ => Err(usage.into()),
    }
}

#[cfg(unix)]
fn reject_reused_cli_lease(cli: &Cli) -> Result<(), String> {
    if cli.lease_epoch.is_none() {
        return Ok(());
    }
    Err("--lease cannot be reused across CLI invocations: control leases are bound to the client connection that acquired them. Omit --lease to acquire atomically, or use control-hold/verify for persistent lease testing.".into())
}

#[cfg(unix)]
fn default_cwd(cli: &Cli) -> Result<String, String> {
    if let Some(cwd) = &cli.cwd {
        return Ok(cwd.clone());
    }
    std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("current directory: {error}"))
}

#[cfg(unix)]
fn new_id(prefix: &str) -> String {
    format!("{}_{}", prefix, Uuid::new_v4())
}

#[cfg(unix)]
fn first_pane_id(workspace: &WorkspaceDocument) -> Option<String> {
    workspace
        .tabs
        .iter()
        .find_map(|tab| first_leaf_id(&tab.root))
}

#[cfg(unix)]
fn first_leaf_id(tree: &PaneTree) -> Option<String> {
    match tree {
        PaneTree::Leaf { id, .. } => Some(id.clone()),
        PaneTree::Split { children, .. } => children.iter().find_map(first_leaf_id),
    }
}

#[cfg(unix)]
fn collect_leaf_ids(tree: &PaneTree, ids: &mut Vec<String>) {
    match tree {
        PaneTree::Leaf { id, .. } => ids.push(id.clone()),
        PaneTree::Split { children, .. } => {
            for child in children {
                collect_leaf_ids(child, ids);
            }
        }
    }
}

#[cfg(unix)]
fn shell_single_quote(value: &str) -> String {
    value.replace('\'', "'\"'\"'")
}

#[cfg(unix)]
fn print_json<T: Serialize>(value: &T) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
    );
    Ok(())
}

#[cfg(unix)]
fn format_remote_error(error: RemoteError) -> String {
    if error.retryable {
        format!("{}: {} (retryable)", error.code, error.message)
    } else {
        format!("{}: {}", error.code, error.message)
    }
}

#[cfg(unix)]
fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KiB", "MiB", "GiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} {}", bytes, UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

#[cfg(unix)]
fn print_help() {
    println!(
        "yterminal-agent {}\n\nUSAGE:\n  yterminal-agent COMMAND [OPTIONS]\n  yterminal-agent help [COMMAND]\n\nSERVICE / STATUS:\n  daemon [--socket PATH] [--database PATH]\n  connect [--socket PATH]\n  status [--json] [--socket PATH]\n  install | start | restart | stop\n  hot-restart [--timeout MS] [--json]        # restart preserving live panes' scrollback\n  ping [--socket PATH]\n  doctor [--socket PATH]\n  drain on|off [--socket PATH]\n  shutdown [--socket PATH]        # requires drain on and zero live sessions\n  version",
        env!("CARGO_PKG_VERSION")
    );
    println!(
        "\nWORKSPACE / PTY:\n  workspaces [--json] [--socket PATH]\n  workspace-get WORKSPACE_ID [--json] [--socket PATH]\n  workspace-create [--name NAME] [--cwd PATH] [--json] [--socket PATH]\n  workspace-delete WORKSPACE_ID [--socket PATH]\n  control WORKSPACE_ID [--force] [--json] [--socket PATH]\n  control-hold WORKSPACE_ID [--force] [--timeout MS] [--json] [--socket PATH]\n  sessions [--json] [--socket PATH]\n  spawn WORKSPACE_ID [--pane ID] [--file PATH] [--cwd PATH] [--cols N] [--rows N] [--json] [--socket PATH] [-- ARG ...]\n  attach SESSION_ID [--after SEQ] [--cols N] [--rows N] [--timeout MS] [--take-control] [--socket PATH]\n  input SESSION_ID [TEXT] [--newline] [--socket PATH]\n  input-line SESSION_ID [TEXT] [--socket PATH]\n  resize SESSION_ID --cols N --rows N [--socket PATH]\n  kill SESSION_ID [--socket PATH]\n  smoke [--timeout MS] [--keep] [--json] [--socket PATH]\n  verify [--timeout MS] [--json] [--socket PATH]\n\nGROUPED ALIASES:\n  workspace list|get|create|delete ...\n  session list|spawn|attach|input|input-line|resize|kill ...\n\nRun `yterminal-agent help COMMAND` or `COMMAND --help` for details."
    );
}

#[cfg(unix)]
fn print_command_help(command: &str) -> Result<(), String> {
    let text = match command {
        "status" => "status [--json] [--socket PATH]\nShows managed-service state for the default socket, or only runtime state for a custom socket.",
        "workspaces" | "workspace-list" => "workspaces [--json] [--socket PATH]\nLists authoritative workspace documents.",
        "workspace-get" => "workspace-get WORKSPACE_ID [--json] [--socket PATH]",
        "workspace-create" => "workspace-create [--name NAME] [--cwd PATH] [--json] [--socket PATH]",
        "workspace-delete" => "workspace-delete WORKSPACE_ID [--socket PATH]\nForce-acquires control, terminates its PTYs, and removes the workspace.",
        "control" => "control WORKSPACE_ID [--force] [--json] [--socket PATH]\nProbes acquisition only; the lease is released when this process exits. Use control-hold to retain it.",
        "control-hold" => "control-hold WORKSPACE_ID [--force] [--timeout MS] [--json] [--socket PATH]\nKeeps one client-scoped lease alive with 5-second heartbeats, then releases it. Default timeout: 30000 ms.",
        "sessions" | "session-list" => "sessions [--json] [--socket PATH]",
        "spawn" => "spawn WORKSPACE_ID [--pane ID] [--file PATH] [--cwd PATH] [--cols N] [--rows N] [--json] [--socket PATH] [-- ARG ...]\nForce-acquires control and spawns a daemon-owned PTY.",
        "attach" => "attach SESSION_ID [--after SEQ] [--cols N] [--rows N] [--timeout MS] [--take-control] [--socket PATH]\nStreams raw ANSI output and does not forward stdin. Default timeout: 2000 ms; 0 waits indefinitely. Without --take-control it is a read-only watcher and requested dimensions cannot resize the canonical PTY.",
        "input" => "input SESSION_ID [TEXT] [--newline] [--socket PATH]\nForce-acquires control in this same client and sends bytes. If TEXT is omitted, reads stdin to EOF.",
        "input-line" => "input-line SESSION_ID [TEXT] [--socket PATH]\nLike input, always appending a newline.",
        "resize" => "resize SESSION_ID --cols N --rows N [--socket PATH]\nForce-acquires control in this same client and changes the canonical PTY grid.",
        "kill" => "kill SESSION_ID [--socket PATH]\nForce-acquires control in this same client and terminates the PTY.",
        "smoke" | "self-test" => "smoke [--timeout MS] [--keep] [--json] [--socket PATH]\nRuns a small create/spawn/input/output/exit/delete check.",
        "verify" | "protocol-smoke" => "verify [--timeout MS] [--json] [--socket PATH]\nRuns the comprehensive two-client protocol suite: every workspace operation, control takeover/heartbeat/release, PTY attach/input/resize/kill, checkpoint and incremental replay, plus cwd/process/Git/file services. Temporary resources are cleaned even on failure.",
        "drain" => "drain on|off [--socket PATH]",
        "shutdown" => "shutdown [--socket PATH]\nRequires drain on and zero live sessions.",
        "hot-restart" => "hot-restart [--timeout MS] [--json]\nRestarts the installed system service while sessions are live. Shells restart, but each pane inherits its predecessor's checkpointed scrollback so a fresh attach replays history; the GUI reconnects and re-spawns automatically, and coding agents resume. Unlike shutdown it has no zero-session gate. Cannot target a custom --socket daemon. Default timeout: 30000 ms.",
        "doctor" => "doctor [--socket PATH]",
        "ping" => "ping [--socket PATH]",
        "daemon" => "daemon [--socket PATH] [--database PATH]",
        "connect" => "connect [--socket PATH]\nBridges the local agent protocol over stdin/stdout for system OpenSSH.",
        "version" => "version",
        other => return Err(format!("unknown help command: {other}")),
    };
    println!("USAGE:\n  yterminal-agent {text}");
    Ok(())
}

#[cfg(all(test, unix))]
mod cli_tests {
    use super::*;

    #[test]
    fn grouped_workspace_and_session_commands_normalize() {
        let mut workspace = Cli {
            command: "workspace".into(),
            positionals: vec!["create".into()],
            ..Cli::default()
        };
        normalize_grouped_command(&mut workspace).unwrap();
        assert_eq!(workspace.command, "workspace-create");
        assert!(workspace.positionals.is_empty());

        let mut session = Cli {
            command: "session".into(),
            positionals: vec!["attach".into(), "session-id".into()],
            ..Cli::default()
        };
        normalize_grouped_command(&mut session).unwrap();
        assert_eq!(session.command, "attach");
        assert_eq!(session.positionals, ["session-id"]);
    }

    #[test]
    fn reused_command_line_lease_is_rejected_with_actionable_guidance() {
        let cli = Cli {
            lease_epoch: Some(42),
            ..Cli::default()
        };
        let error = reject_reused_cli_lease(&cli).unwrap_err();
        assert!(error.contains("client connection"));
        assert!(error.contains("control-hold"));
    }

    #[test]
    fn packaged_gui_dispatches_every_cli_entrypoint_without_opening_the_ui() {
        for command in [
            "status",
            "workspace",
            "session",
            "control-hold",
            "verify",
            "hot-restart",
            "help",
        ] {
            assert!(
                handles_command(command),
                "missing CLI dispatch for {command}"
            );
        }
        assert!(!handles_command("ordinary-gui-argument"));
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("yterminal-agent remote workspaces currently require macOS or Linux");
    std::process::exit(1);
}
