#![cfg(unix)]

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::mpsc;
use uuid::Uuid;
use yterminal::agent::run_daemon;
use yterminal::agent_client::{AgentClient, AgentClientEvent};
use yterminal::remote_protocol::{EventBody, RequestBody, ResponseBody};
use yterminal::workspace::{PaneTree, TabDocument, WorkspaceDocument, WorkspaceOperation};

fn workspace() -> WorkspaceDocument {
    WorkspaceDocument {
        id: "ssh-workspace".into(),
        revision: 0,
        name: "SSH workspace".into(),
        icon: None,
        tabs: vec![TabDocument {
            id: "ssh-tab".into(),
            name: "shell".into(),
            custom_name: None,
            icon: None,
            cwd: "/tmp".into(),
            root: PaneTree::Leaf {
                id: "ssh-pane".into(),
                cwd: "/tmp".into(),
                session_id: None,
                agent: None,
                runtime_status: None,
                runtime_title: None,
            },
            file: None,
        }],
    }
}

async fn wait_for_output(events: &mut mpsc::Receiver<AgentClientEvent>, expected: &str) -> Vec<u8> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut output = Vec::new();
    while tokio::time::Instant::now() < deadline {
        let event = tokio::time::timeout(Duration::from_millis(500), events.recv())
            .await
            .expect("SSH output event timeout")
            .expect("SSH event channel closed");
        if let AgentClientEvent::Message(EventBody::Output { bytes, .. }) = event {
            output.extend_from_slice(&bytes);
            if String::from_utf8_lossy(&output).contains(expected) {
                return output;
            }
        }
    }
    panic!(
        "did not receive {expected:?}; output={:?}",
        String::from_utf8_lossy(&output)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ssh_stdio_bridge_reattaches_the_same_live_session() {
    let suffix = Uuid::new_v4().to_string();
    let root = PathBuf::from("/tmp").join(format!("yt-ssh-{}", &suffix[..8]));
    std::fs::create_dir_all(&root).unwrap();
    let runtime = root.join("runtime");
    let socket = runtime.join("yterminal/agent.sock");
    let database = root.join("agent.db");
    let daemon_socket = socket.clone();
    let daemon = tokio::spawn(async move {
        run_daemon(Some(daemon_socket), Some(database))
            .await
            .unwrap();
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if tokio::net::UnixStream::connect(&socket).await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();

    let fake_ssh = root.join("ssh");
    std::fs::write(&fake_ssh, "#!/bin/sh\nexec \"$FAKE_AGENT_BIN\" connect\n").unwrap();
    std::fs::set_permissions(&fake_ssh, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::env::set_var("YTERMINAL_SSH_BIN", &fake_ssh);
    // The service installer copies the main app executable. Exercise that
    // exact artifact's early `connect` dispatch, not only the helper binary.
    std::env::set_var("FAKE_AGENT_BIN", env!("CARGO_BIN_EXE_yterminal"));
    std::env::set_var("XDG_RUNTIME_DIR", &runtime);

    let (events, mut event_rx) = mpsc::channel(512);
    let (client, mut child) = AgentClient::connect_ssh("fake-host", "integration", events)
        .await
        .unwrap();
    assert_eq!(
        client.request(RequestBody::Ping).await.unwrap(),
        ResponseBody::Pong
    );
    assert!(matches!(
        client
            .request(RequestBody::CreateWorkspace {
                workspace: workspace()
            })
            .await
            .unwrap(),
        ResponseBody::Workspace { .. }
    ));
    let first_lease = match client
        .request(RequestBody::AcquireControl {
            workspace_id: "ssh-workspace".into(),
            force: false,
        })
        .await
        .unwrap()
    {
        ResponseBody::ControlAcquired { lease_epoch, .. } => lease_epoch,
        other => panic!("unexpected control response: {other:?}"),
    };
    let session_id = match client
        .request(RequestBody::SpawnSession {
            workspace_id: "ssh-workspace".into(),
            pane_id: "ssh-pane".into(),
            lease_epoch: first_lease,
            file: "/bin/sh".into(),
            args: Vec::new(),
            cols: 80,
            rows: 24,
            cwd: Some("/tmp".into()),
            env: BTreeMap::new(),
        })
        .await
        .unwrap()
    {
        ResponseBody::SessionSpawned { session_id, .. } => session_id,
        other => panic!("unexpected spawn response: {other:?}"),
    };
    assert!(matches!(
        client
            .request(RequestBody::AttachSession {
                session_id: session_id.clone(),
                after_seq: None,
                cols: 80,
                rows: 24,
            })
            .await
            .unwrap(),
        ResponseBody::Ack
    ));
    client
        .notify(RequestBody::Input {
            session_id: session_id.clone(),
            lease_epoch: first_lease,
            bytes: b"printf 'ssh-before-disconnect\\n'\n".to_vec().into(),
        })
        .await
        .unwrap();
    wait_for_output(&mut event_rx, "ssh-before-disconnect").await;

    // A second attached client is a watcher. Even if it knows the current
    // epoch, the daemon rejects destructive requests from the wrong client.
    let (watcher_events, mut watcher_event_rx) = mpsc::channel(512);
    let (watcher, mut watcher_child) =
        AgentClient::connect_ssh("fake-host", "watcher", watcher_events)
            .await
            .unwrap();
    let current_revision = match client
        .request(RequestBody::GetWorkspace {
            workspace_id: "ssh-workspace".into(),
        })
        .await
        .unwrap()
    {
        ResponseBody::Workspace { workspace } => workspace.revision,
        other => panic!("unexpected workspace response: {other:?}"),
    };
    client
        .request(RequestBody::ApplyWorkspaceOp {
            workspace_id: "ssh-workspace".into(),
            base_revision: current_revision,
            lease_epoch: first_lease,
            operation: WorkspaceOperation::RenameWorkspace {
                name: "Shared over SSH".into(),
            },
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(AgentClientEvent::Message(EventBody::WorkspaceChanged { workspace })) =
                watcher_event_rx.recv().await
            {
                if workspace.name == "Shared over SSH" {
                    break;
                }
            }
        }
    })
    .await
    .expect("watcher did not receive the shared workspace revision");
    let denied = watcher
        .request(RequestBody::KillSession {
            session_id: session_id.clone(),
            lease_epoch: first_lease,
        })
        .await
        .unwrap_err();
    assert_eq!(denied.code, "stale_control_lease");
    watcher_child.start_kill().unwrap();
    let _ = watcher_child.wait().await;
    drop(watcher);

    // Simulate a GUI/network loss: kill only the OpenSSH channel. The daemon
    // and the PTY it owns must remain alive for the next client.
    child.start_kill().unwrap();
    let _ = child.wait().await;
    drop(client);

    let (events, mut reconnect_events) = mpsc::channel(512);
    let (reconnected, mut second_child) =
        AgentClient::connect_ssh("fake-host", "reconnected", events)
            .await
            .unwrap();
    let listed = reconnected
        .request(RequestBody::ListWorkspaces)
        .await
        .unwrap();
    assert!(matches!(
        listed,
        ResponseBody::Workspaces { workspaces }
            if workspaces.iter().any(|workspace| workspace.id == "ssh-workspace")
    ));
    let sessions = reconnected
        .request(RequestBody::ListSessions)
        .await
        .unwrap();
    assert!(matches!(
        sessions,
        ResponseBody::Sessions { sessions }
            if sessions.iter().any(|session| session.session_id == session_id)
    ));
    let second_lease = match reconnected
        .request(RequestBody::AcquireControl {
            workspace_id: "ssh-workspace".into(),
            force: true,
        })
        .await
        .unwrap()
    {
        ResponseBody::ControlAcquired { lease_epoch, .. } => lease_epoch,
        other => panic!("unexpected reconnect control response: {other:?}"),
    };
    assert!(matches!(
        reconnected
            .request(RequestBody::AttachSession {
                session_id: session_id.clone(),
                after_seq: None,
                cols: 80,
                rows: 24,
            })
            .await
            .unwrap(),
        ResponseBody::Ack
    ));
    wait_for_output(&mut reconnect_events, "ssh-before-disconnect").await;
    reconnected
        .notify(RequestBody::Input {
            session_id: session_id.clone(),
            lease_epoch: second_lease,
            bytes: b"printf 'ssh-after-reconnect\\n'\n".to_vec().into(),
        })
        .await
        .unwrap();
    wait_for_output(&mut reconnect_events, "ssh-after-reconnect").await;
    assert!(matches!(
        reconnected
            .request(RequestBody::KillSession {
                session_id,
                lease_epoch: second_lease,
            })
            .await
            .unwrap(),
        ResponseBody::Ack
    ));
    second_child.start_kill().unwrap();
    let _ = second_child.wait().await;

    std::env::remove_var("YTERMINAL_SSH_BIN");
    std::env::remove_var("FAKE_AGENT_BIN");
    std::env::remove_var("XDG_RUNTIME_DIR");
    daemon.abort();
    let _ = std::fs::remove_dir_all(root);
}
