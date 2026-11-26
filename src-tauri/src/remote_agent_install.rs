use flate2::read::GzDecoder;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;
use std::process::{Output, Stdio};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use yterminal::agent_client::ssh_command;

const REPOSITORY: &str = "yanickxia/yterminal";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_METADATA_BYTES: usize = 2 * 1024 * 1024;
const MAX_AGENT_BYTES: usize = 64 * 1024 * 1024;

const PROBE: &str = r#"
set -eu
agent="$HOME/.local/bin/yterminal-agent"
if [ -f "$agent" ] && [ -x "$agent" ]; then
    printf 'yterminal-bootstrap present\n'
elif [ -e "$agent" ] || [ -L "$agent" ]; then
    printf 'Agent path exists but is not an executable file: %s\n' "$agent" >&2
    exit 1
else
    printf 'yterminal-bootstrap missing %s %s\n' "$(uname -s)" "$(uname -m)"
fi
"#;

const INSTALL: &str = r#"
set -eu
umask 077
dir="$HOME/.local/bin"
agent="$dir/yterminal-agent"
mkdir -p "$dir"
tmp=$(mktemp "$dir/.yterminal-agent.XXXXXXXX")
trap 'rm -f "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$tmp"
if [ "$(wc -c < "$tmp" | tr -d '[:space:]')" != "$1" ]; then
    printf 'Incomplete Agent upload\n' >&2
    exit 1
fi
if [ -f "$agent" ] && [ -x "$agent" ]; then exit 0; fi
if [ -e "$agent" ] || [ -L "$agent" ]; then
    printf 'Agent path already exists: %s\n' "$agent" >&2
    exit 1
fi
chmod 755 "$tmp"
if [ "$("$tmp" version </dev/null)" != "yterminal-agent $2" ]; then
    printf 'Downloaded Agent could not run on this SSH host\n' >&2
    exit 1
fi
# Publish the complete file without replacing an Agent installed concurrently.
if ! ln "$tmp" "$agent"; then
    test -f "$agent" && test -x "$agent"
    exit $?
fi
if "$agent" ping >/dev/null 2>&1 || "$agent" install >/dev/null; then exit 0; fi
# Headless hosts may have no systemd user bus or GUI launchd domain.
nohup "$agent" daemon </dev/null >/dev/null 2>&1 &
for attempt in 1 2 3 4 5; do
    sleep 1
    if "$agent" ping >/dev/null 2>&1; then exit 0; fi
done
printf 'Agent was installed but its daemon did not respond\n' >&2
exit 1
"#;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptions {
    pub github_mirror: Option<String>,
    pub http_proxy: Option<String>,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    assets: Vec<ReleaseAsset>,
}

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    size: usize,
    digest: Option<String>,
}

pub async fn install_if_missing(
    target: &str,
    options: &InstallOptions,
    progress: impl Fn(&str),
) -> Result<(), String> {
    progress("Checking for yterminal-agent…");
    let probe = run_ssh(target, &sh_command(PROBE), None, 15).await?;
    let Some(asset_name) = probe_asset(&String::from_utf8_lossy(&probe.stdout))? else {
        return Ok(());
    };
    progress("Downloading and verifying yterminal-agent on this computer…");
    let archive = download_archive(&asset_name, options).await?;
    let binary = tokio::task::spawn_blocking(move || unpack_agent(&archive))
        .await
        .map_err(|error| format!("Unpack Agent task: {error}"))??;
    progress("Uploading and starting yterminal-agent over SSH…");
    // Size is numeric and VERSION comes from this app's manifest. Quote both
    // as shell arguments so only the fixed script is evaluated remotely.
    let command = format!(
        "{} yterminal-bootstrap {} {}",
        sh_command(INSTALL),
        binary.len(),
        shell_quote(VERSION)
    );
    run_ssh(target, &command, Some(&binary), 55).await?;
    progress("Connecting to yterminal-agent…");
    Ok(())
}

fn probe_asset(output: &str) -> Result<Option<String>, String> {
    let line = output
        .lines()
        .find_map(|line| line.strip_prefix("yterminal-bootstrap "))
        .ok_or_else(|| "SSH host did not return an Agent platform".to_string())?;
    let platform = match line.split_whitespace().collect::<Vec<_>>().as_slice() {
        ["present"] => return Ok(None),
        ["missing", "Linux", "x86_64" | "amd64"] => "linux_x86_64",
        ["missing", "Linux", "aarch64" | "arm64"] => "linux_aarch64",
        ["missing", "Darwin", "x86_64" | "arm64" | "aarch64"] => "macos_universal",
        ["missing", os, arch] => {
            return Err(format!("No published Agent for SSH host {os} {arch}"));
        }
        _ => return Err("SSH host returned an invalid Agent platform".into()),
    };
    Ok(Some(format!("yterminal-agent_{VERSION}_{platform}.tar.gz")))
}

async fn download_archive(name: &str, options: &InstallOptions) -> Result<Vec<u8>, String> {
    let client = crate::updater_http_client(options.http_proxy.as_deref())
        .map_err(|_| "Could not configure the update HTTP proxy".to_string())?;
    let tag = format!("v{VERSION}");
    let metadata_url = format!("https://api.github.com/repos/{REPOSITORY}/releases/tags/{tag}");
    let metadata = fetch_bytes(&client, &metadata_url, MAX_METADATA_BYTES)
        .await
        .map_err(|error| format!("Read GitHub release {tag}: {error}"))?;
    let release: Release = serde_json::from_slice(&metadata)
        .map_err(|error| format!("Invalid GitHub release metadata: {error}"))?;
    if release.draft || release.tag_name != tag {
        return Err(format!("GitHub release {tag} is not published"));
    }
    let asset = release
        .assets
        .into_iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| format!("GitHub release {tag} has no {name}"))?;
    let digest = asset
        .digest
        .filter(|digest| {
            digest.strip_prefix("sha256:").is_some_and(|hex| {
                hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        })
        .ok_or_else(|| format!("GitHub did not provide a SHA-256 digest for {name}"))?;
    if asset.size == 0 || asset.size > MAX_AGENT_BYTES {
        return Err(format!("Unexpected GitHub asset size for {name}"));
    }
    let url = format!("https://github.com/{REPOSITORY}/releases/download/{tag}/{name}");
    // Validate bytes against GitHub's digest even when using a download mirror.
    if let Ok(mirror) = crate::github_mirror_url(&url, options.github_mirror.as_deref()) {
        if mirror != url {
            if let Ok(bytes) = verified_download(&client, &mirror, asset.size, &digest).await {
                return Ok(bytes);
            }
        }
    }
    verified_download(&client, &url, asset.size, &digest)
        .await
        .map_err(|error| format!("Download {name}: {error}"))
}

async fn verified_download(
    client: &reqwest::Client,
    url: &str,
    size: usize,
    digest: &str,
) -> Result<Vec<u8>, String> {
    let bytes = fetch_bytes(client, url, size).await?;
    let actual = format!("sha256:{:x}", Sha256::digest(&bytes));
    if bytes.len() != size || !actual.eq_ignore_ascii_case(digest) {
        return Err("Agent archive does not match GitHub's size and SHA-256 digest".into());
    }
    Ok(bytes)
}

async fn fetch_bytes(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, format!("yterminal/{VERSION}"))
        .timeout(Duration::from_secs(40))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| error.without_url().to_string())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| error.without_url().to_string())?
    {
        if chunk.len() > limit - bytes.len() {
            return Err("GitHub response exceeded the expected size".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn unpack_agent(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut archive = tar::Archive::new(GzDecoder::new(bytes));
    let mut entries = archive.entries().map_err(|error| error.to_string())?;
    let mut entry = entries
        .next()
        .ok_or_else(|| "Agent archive is empty".to_string())?
        .map_err(|error| error.to_string())?;
    let path = entry.path().map_err(|error| error.to_string())?;
    if path != Path::new("yterminal-agent")
        || !entry.header().entry_type().is_file()
        || entry.size() == 0
        || entry.size() > MAX_AGENT_BYTES as u64
    {
        return Err("Agent archive does not contain the expected executable".into());
    }
    let mut binary = Vec::with_capacity(entry.size() as usize);
    entry
        .read_to_end(&mut binary)
        .map_err(|error| error.to_string())?;
    if binary.len() as u64 != entry.size() || entries.next().is_some() {
        return Err("Agent archive does not contain exactly one complete executable".into());
    }
    Ok(binary)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn sh_command(script: &str) -> String {
    format!("sh -c {}", shell_quote(script))
}

async fn run_ssh(
    target: &str,
    command: &str,
    input: Option<&[u8]>,
    timeout_secs: u64,
) -> Result<Output, String> {
    let mut child = ssh_command(target, command)?
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Start OpenSSH: {error}"))?;
    let pipe = child.stdin.take();
    let send = async move {
        if let (Some(mut pipe), Some(input)) = (pipe, input) {
            pipe.write_all(input).await?;
            pipe.shutdown().await?;
        }
        Ok::<_, std::io::Error>(())
    };
    let (sent, output) = tokio::time::timeout(Duration::from_secs(timeout_secs), async {
        tokio::join!(send, child.wait_with_output())
    })
    .await
    .map_err(|_| "SSH Agent setup timed out".to_string())?;
    let output = output.map_err(|error| format!("Read OpenSSH result: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message: String = stderr.trim().chars().take(2048).collect();
        return Err(format!("SSH exited {}: {message}", output.status));
    }
    sent.map_err(|error| format!("Upload Agent over SSH: {error}"))?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn selects_the_exact_release_asset_from_remote_platform() {
        for (system, platform) in [
            ("Linux x86_64", "linux_x86_64"),
            ("Linux aarch64", "linux_aarch64"),
            ("Darwin arm64", "macos_universal"),
            ("Darwin x86_64", "macos_universal"),
        ] {
            assert_eq!(
                probe_asset(&format!(
                    "login banner\nyterminal-bootstrap missing {system}\n"
                ))
                .unwrap(),
                Some(format!("yterminal-agent_{VERSION}_{platform}.tar.gz"))
            );
        }
        assert_eq!(probe_asset("yterminal-bootstrap present\n").unwrap(), None);
        assert!(probe_asset("yterminal-bootstrap missing Linux armv7l\n").is_err());
        assert!(probe_asset("unrelated banner only\n").is_err());
    }

    #[test]
    fn accepts_only_the_standalone_agent_archive() {
        fn make_archive(names: &[&str]) -> Vec<u8> {
            let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            let mut archive = tar::Builder::new(gzip);
            for name in names {
                let mut header = tar::Header::new_gnu();
                header.set_size(5);
                header.set_mode(0o755);
                archive
                    .append_data(&mut header, name, &b"agent"[..])
                    .unwrap();
            }
            archive.into_inner().unwrap().finish().unwrap()
        }

        assert_eq!(
            unpack_agent(&make_archive(&["yterminal-agent"])).unwrap(),
            b"agent"
        );
        assert!(unpack_agent(&make_archive(&["unexpected"])).is_err());
        assert!(unpack_agent(&make_archive(&["yterminal-agent", "unexpected"])).is_err());
    }

    #[test]
    fn remote_install_preserves_existing_binary_and_rejects_truncated_uploads() {
        let home = std::env::temp_dir().join(format!("yterminal-install-{}", uuid::Uuid::new_v4()));
        let agent = home.join(".local/bin/yterminal-agent");
        let executable = format!("#!/bin/sh\ncase \"$1\" in\nversion) echo 'yterminal-agent {VERSION}';;\nping) exit 1;;\ninstall) touch \"$HOME/started\";;\nesac\n");
        let upload = |bytes: &[u8]| {
            let mut child = std::process::Command::new("sh")
                .args([
                    "-c",
                    INSTALL,
                    "yterminal-bootstrap",
                    &executable.len().to_string(),
                    VERSION,
                ])
                .env("HOME", &home)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(bytes).unwrap();
            child.wait_with_output().unwrap()
        };
        let output = upload(b"truncated");
        assert!(!output.status.success());
        assert!(!agent.exists());
        assert_eq!(
            std::fs::read_dir(agent.parent().unwrap()).unwrap().count(),
            0
        );
        let output = upload(executable.as_bytes());
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(home.join("started").is_file());
        let output = upload(&vec![b'X'; executable.len()]);
        assert!(output.status.success());
        assert_eq!(std::fs::read_to_string(&agent).unwrap(), executable);
        assert_eq!(
            std::fs::read_dir(agent.parent().unwrap()).unwrap().count(),
            1
        );
        std::fs::remove_dir_all(home).unwrap();
    }
}
