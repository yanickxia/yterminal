use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
    Form, Router,
};
use serde::{Deserialize, Serialize};
use std::{env, fs, io, os::unix::fs::OpenOptionsExt, path::PathBuf, sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;
use tower_http::services::ServeDir;
use uuid::Uuid;
use yterminal::{
    agent_client::{AgentClient, AgentClientEvent, EVENT_CAPACITY},
    remote_protocol::{
        AgentHello, EventBody, RemoteError, RequestBody, ResponseBody, MAX_FRAME_BYTES,
    },
};

const COOKIE: &str = "yterminal_session";
const LOGIN_PAGE: &str = include_str!("web-login.html");
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(25);

struct AppState {
    index: String,
    token: String,
    session: String,
    origin: Option<String>,
}

#[derive(Deserialize)]
struct Login {
    token: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Host {
    Local,
    Ssh { target: String },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BrowserMessage {
    Connect { host: Host, name: String },
    Request { id: u64, request: RequestBody },
    Notify { id: u64, request: RequestBody },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum GatewayMessage {
    Connected {
        hello: AgentHello,
        #[serde(rename = "connectionId")]
        connection_id: Uuid,
    },
    ConnectError {
        message: String,
    },
    Response {
        id: u64,
        result: Result<Option<ResponseBody>, RemoteError>,
    },
    Agent {
        payload: EventBody,
    },
    Diagnostic {
        payload: ConnectionMessage,
    },
    Disconnected {
        payload: ConnectionMessage,
    },
}

#[derive(Serialize)]
struct ConnectionMessage {
    message: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let assets = PathBuf::from(env::var("YTERMINAL_WEB_ASSETS").unwrap_or_else(|_| "dist".into()));
    let origin = env::var("YTERMINAL_WEB_ORIGIN")
        .ok()
        .filter(|value| !value.is_empty());
    if let Some(value) = &origin {
        let uri: Uri = value.parse()?;
        if !matches!(uri.scheme_str(), Some("http" | "https"))
            || uri.authority().is_none()
            || value.ends_with('/')
            || uri
                .path_and_query()
                .is_some_and(|path| path.as_str() != "/")
        {
            return Err("YTERMINAL_WEB_ORIGIN must be an HTTP(S) origin such as https://terminal.example.com".into());
        }
    }
    let token = match env::var("YTERMINAL_WEB_TOKEN") {
        Ok(token) if !token.trim().is_empty() => token.trim().to_owned(),
        _ => load_or_create_token(PathBuf::from(env::var("YTERMINAL_WEB_TOKEN_FILE")?))?,
    };
    let state = Arc::new(AppState {
        index: fs::read_to_string(assets.join("index.html"))?,
        token,
        session: Uuid::new_v4().to_string(),
        origin,
    });
    let app = Router::new()
        .route("/", get(index))
        .route("/login", post(login))
        .route("/api/session", get(session_status))
        .route("/api/host", get(connect))
        .nest_service("/assets", ServeDir::new(assets.join("assets")))
        .with_state(state);
    let bind = env::var("YTERMINAL_WEB_LISTEN").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(bind).await?;
    eprintln!("yterminal Web listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}

fn load_or_create_token(path: PathBuf) -> io::Result<String> {
    use std::io::Write;

    match fs::read_to_string(&path) {
        Ok(token) if !token.trim().is_empty() => Ok(token.trim().into()),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Web token file is empty",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let token = Uuid::new_v4().simple().to_string();
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .mode(0o600)
                .write(true)
                .open(path)?;
            writeln!(file, "{token}")?;
            file.sync_all()?;
            Ok(token)
        }
        Err(error) => Err(error),
    }
}

fn authorized(headers: &HeaderMap, state: &AppState) -> bool {
    headers.get_all(header::COOKIE).iter().any(|cookies| {
        cookies.to_str().is_ok_and(|cookies| {
            cookies.split(';').any(|cookie| {
                cookie.trim().split_once('=').is_some_and(|(key, value)| {
                    key == COOKIE && bool::from(value.as_bytes().ct_eq(state.session.as_bytes()))
                })
            })
        })
    })
}

fn same_origin(headers: &HeaderMap, state: &AppState) -> bool {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    if let Some(expected) = &state.origin {
        return origin == expected;
    }
    origin.parse::<Uri>().is_ok_and(|uri| {
        uri.scheme_str() == Some("http")
            && uri.authority().is_some_and(|authority| {
                headers
                    .get(header::HOST)
                    .and_then(|value| value.to_str().ok())
                    == Some(authority.as_str())
            })
    })
}

async fn index(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let html = if authorized(&headers, &state) {
        state.index.clone()
    } else {
        LOGIN_PAGE.replace("{{error}}", "")
    };
    page(StatusCode::OK, html)
}

fn page(status: StatusCode, html: String) -> Response {
    (
        status,
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::X_FRAME_OPTIONS, "DENY"),
            (header::REFERRER_POLICY, "same-origin"),
        ],
        Html(html),
    )
        .into_response()
}

async fn login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Form(form): Form<Login>,
) -> Response {
    if !same_origin(&headers, &state) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !bool::from(form.token.trim().as_bytes().ct_eq(state.token.as_bytes())) {
        return page(
            StatusCode::UNAUTHORIZED,
            LOGIN_PAGE.replace("{{error}}", "Invalid access token."),
        );
    }
    let secure = if state
        .origin
        .as_ref()
        .is_some_and(|value| value.starts_with("https://"))
    {
        "; Secure"
    } else {
        ""
    };
    (
        [
            (header::CACHE_CONTROL, "no-store".into()),
            (
                header::SET_COOKIE,
                format!(
                    "{COOKIE}={}; Path=/; HttpOnly; SameSite=Strict{secure}",
                    state.session
                ),
            ),
        ],
        Redirect::to("/"),
    )
        .into_response()
}

async fn session_status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let status = if authorized(&headers, &state) {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::UNAUTHORIZED
    };
    (status, [(header::CACHE_CONTROL, "no-store")]).into_response()
}

async fn connect(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !same_origin(&headers, &state) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !authorized(&headers, &state) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.max_message_size(4 * MAX_FRAME_BYTES)
        .max_frame_size(4 * MAX_FRAME_BYTES)
        .on_upgrade(handle_connection)
}

async fn handle_connection(mut ws: WebSocket) {
    let Ok(Some(Ok(Message::Text(text)))) =
        tokio::time::timeout(HANDSHAKE_TIMEOUT, ws.recv()).await
    else {
        return;
    };
    let Ok(BrowserMessage::Connect { host, name }) = serde_json::from_str(&text) else {
        return;
    };
    let (events, mut event_rx) = mpsc::channel(EVENT_CAPACITY);
    let opened = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        match host {
            Host::Local => AgentClient::connect_local(name, events)
                .await
                .map(|client| (client, None)),
            Host::Ssh { target } => AgentClient::connect_ssh(&target, name, events)
                .await
                .map(|(client, child)| (client, Some(child))),
        }
    })
    .await
    .unwrap_or_else(|_| Err("Execution host handshake timed out".into()));
    let (client, _ssh_child) = match opened {
        Ok(connection) => connection,
        Err(message) => {
            // The SSH client's error includes actionable host-key or login diagnostics.
            let _ = send(&mut ws, GatewayMessage::ConnectError { message }).await;
            return;
        }
    };
    if !send(
        &mut ws,
        GatewayMessage::Connected {
            hello: client.hello.clone(),
            connection_id: Uuid::new_v4(),
        },
    )
    .await
    {
        return;
    }

    // Keep draining output while an attach or other request is in flight.
    // One ordered worker preserves input, checkpoint and workspace operations.
    let (requests, mut request_rx) = mpsc::channel::<BrowserMessage>(128);
    let (replies, mut reply_rx) = mpsc::channel(128);
    let worker = tokio::spawn(async move {
        while let Some(message) = request_rx.recv().await {
            let (id, result) = match message {
                BrowserMessage::Request { id, request } => {
                    (id, client.request(request).await.map(Some))
                }
                BrowserMessage::Notify { id, request } => {
                    (id, client.notify(request).await.map(|()| None))
                }
                BrowserMessage::Connect { .. } => break,
            };
            if replies
                .send(GatewayMessage::Response { id, result })
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let mut keepalive = tokio::time::interval_at(
        tokio::time::Instant::now() + KEEPALIVE_INTERVAL,
        KEEPALIVE_INTERVAL,
    );
    loop {
        let message = tokio::select! {
            inbound = ws.recv() => {
                match inbound {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(message) = serde_json::from_str(&text) else { break };
                        if requests.try_send(message).is_err() { break; }
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    _ => break,
                }
                continue;
            }
            event = event_rx.recv() => match event {
                Some(AgentClientEvent::Message(payload)) => GatewayMessage::Agent { payload },
                Some(AgentClientEvent::Diagnostic(message)) => GatewayMessage::Diagnostic {
                    payload: ConnectionMessage { message },
                },
                Some(AgentClientEvent::Disconnected(message)) => GatewayMessage::Disconnected {
                    payload: ConnectionMessage { message },
                },
                None => break,
            },
            reply = reply_rx.recv() => match reply {
                Some(message) => message,
                None => break,
            },
            _ = keepalive.tick() => {
                if !send_frame(&mut ws, Message::Ping(Default::default())).await {
                    break;
                }
                continue;
            },
        };
        let disconnected = matches!(message, GatewayMessage::Disconnected { .. });
        if !send(&mut ws, message).await || disconnected {
            break;
        }
    }
    worker.abort();
}

async fn send(ws: &mut WebSocket, message: GatewayMessage) -> bool {
    let Ok(json) = serde_json::to_string(&message) else {
        return false;
    };
    send_frame(ws, Message::Text(json.into())).await
}

async fn send_frame(ws: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(10), ws.send(message)).await,
        Ok(Ok(()))
    )
}
