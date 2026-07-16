use std::path::PathBuf;

#[cfg(unix)]
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("yterminal-agent: {error}");
        std::process::exit(1);
    }
}

#[cfg(unix)]
async fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "help".into());
    let mut socket: Option<PathBuf> = None;
    let mut database: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--socket" => {
                socket = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| "--socket requires a path".to_string())?,
                ));
            }
            "--database" => {
                database = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| "--database requires a path".to_string())?,
                ));
            }
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }
    match command.as_str() {
        "daemon" => yterminal::agent::run_daemon(socket, database).await,
        "connect" => yterminal::agent::connect_stdio(socket).await,
        "version" | "--version" | "-V" => {
            println!("yterminal-agent {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        "help" | "--help" | "-h" => {
            println!(
                "yterminal-agent {}\n\nUSAGE:\n  yterminal-agent daemon [--socket PATH] [--database PATH]\n  yterminal-agent connect [--socket PATH]\n  yterminal-agent version",
                env!("CARGO_PKG_VERSION")
            );
            Ok(())
        }
        _ => Err(format!("unknown command: {command}")),
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("yterminal-agent remote workspaces currently require macOS or Linux");
    std::process::exit(1);
}
