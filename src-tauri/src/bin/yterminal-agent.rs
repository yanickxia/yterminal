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
use yterminal::remote_protocol::{
    EventBody, RemoteError, RequestBody, ResponseBody, SessionInfo,
};
#[cfg(unix)]
use yterminal::workspace::{PaneTree, TabDocument, WorkspaceDocument};

#[cfg(unix)]
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
}

#[cfg(unix)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusOutput {
    service: AgentServiceStatus,
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
struct AgentConnection {
    client: AgentClient,
    events_rx: mpsc::Receiver<AgentClientEvent>,
}

#[cfg(unix)]
async fn run() -> Result<(), String> {
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
        "spawn" => spawn_command(&cli).await,
        "attach" => attach_command(&cli).await,
        "input" => input_command(&cli, false).await,
        "input-line" => input_command(&cli, true).await,
        "resize" => resize_command(&cli).await,
        "kill" => kill_command(&cli).await,
        "smoke" | "self-test" => smoke_command(&cli).await,
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
            require_no_positionals(&cli)?;
            print_help();
            Ok(())
        }
        _ => Err(format!("unknown command: {}", cli.command)),
    }
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
            "--" => {
                cli.positionals.extend(args);
                break;
            }
            _ if arg.starts_with("--") => return Err(format!("unknown argument: {arg}")),
            _ => cli.positionals.push(arg),
        }
    }
    Ok(cli)
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
    let service = service::status().await?;
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
        Err(_) if !service.running => None,
        Err(error) => return Err(error),
    };
    if cli.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&StatusOutput { service, runtime })
                .map_err(|error| error.to_string())?
        );
        return Ok(());
    }
    print_service_status(&service);
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
    let workspace_id = one_positional(cli, "usage: yterminal-agent control WORKSPACE_ID [--force]")?;
    let conn = connect_agent(cli, "yterminal-agent cli").await?;
    let lease_epoch = acquire_control(&conn, workspace_id, cli.force).await?;
    let output = ControlOutput {
        workspace_id: workspace_id.to_string(),
        lease_epoch,
    };
    if cli.json {
        print_json(&output)
    } else {
        println!(
            "workspace={} lease={}",
            output.workspace_id, output.lease_epoch
        );
        Ok(())
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
    attach_session(&conn, session_id, cli.after_seq, cli.cols, cli.rows).await?;
    let timeout = Duration::from_millis(cli.timeout_ms.unwrap_or(2_000));
    stream_session_output(&mut conn, session_id, timeout).await?;
    let _ = conn
        .request(RequestBody::DetachSession {
            session_id: session_id.to_string(),
        })
        .await;
    Ok(())
}

#[cfg(unix)]
async fn input_command(cli: &Cli, force_newline: bool) -> Result<(), String> {
    if cli.positionals.is_empty() {
        return Err(
            "usage: yterminal-agent input SESSION_ID [TEXT] [--newline] [--lease EPOCH]".into(),
        );
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
    let session_id = one_positional(cli, "usage: yterminal-agent resize SESSION_ID --cols N --rows N")?;
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
    let session_id = one_positional(cli, "usage: yterminal-agent kill SESSION_ID [--lease EPOCH]")?;
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
        self.client.request(request).await.map_err(format_remote_error)
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
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        let event = if timeout.is_zero() {
            conn.events_rx.recv().await
        } else {
            let now = Instant::now();
            if now >= deadline {
                return Ok(());
            }
            match tokio::time::timeout(deadline - now, conn.events_rx.recv()).await {
                Ok(event) => event,
                Err(_) => return Ok(()),
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
    workspace.tabs.iter().find_map(|tab| first_leaf_id(&tab.root))
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
        "yterminal-agent {}\n\nUSAGE:\n  yterminal-agent daemon [--socket PATH] [--database PATH]\n  yterminal-agent connect [--socket PATH]\n  yterminal-agent status [--json] [--socket PATH]\n  yterminal-agent install\n  yterminal-agent start\n  yterminal-agent restart\n  yterminal-agent stop\n  yterminal-agent ping [--socket PATH]\n  yterminal-agent sessions [--json] [--socket PATH]\n  yterminal-agent drain on|off [--socket PATH]\n  yterminal-agent shutdown [--socket PATH]\n  yterminal-agent doctor [--socket PATH]\n  yterminal-agent version",
        env!("CARGO_PKG_VERSION")
    );
    println!(
        "\nWORKSPACE / PTY:\n  yterminal-agent workspaces [--json]\n  yterminal-agent workspace-get WORKSPACE_ID [--json]\n  yterminal-agent workspace-create [--name NAME] [--cwd PATH] [--json]\n  yterminal-agent workspace-delete WORKSPACE_ID\n  yterminal-agent control WORKSPACE_ID [--force] [--json]\n  yterminal-agent spawn WORKSPACE_ID [--pane PANE_ID] [--file PATH] [--cwd PATH] [--cols N] [--rows N] [--json] [-- ARG ...]\n  yterminal-agent attach SESSION_ID [--after SEQ] [--cols N] [--rows N] [--timeout MS]\n  yterminal-agent input SESSION_ID [TEXT] [--newline] [--lease EPOCH]\n  yterminal-agent input-line SESSION_ID [TEXT] [--lease EPOCH]\n  yterminal-agent resize SESSION_ID --cols N --rows N [--lease EPOCH]\n  yterminal-agent kill SESSION_ID [--lease EPOCH]\n  yterminal-agent smoke [--timeout MS] [--keep] [--json]"
    );
}

#[cfg(not(unix))]
fn main() {
    eprintln!("yterminal-agent remote workspaces currently require macOS or Linux");
    std::process::exit(1);
}
