#!/usr/bin/env bash
set -euo pipefail

target="${1:-yanick@10.211.55.3}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
remote_cmd_prefix='source ~/.zshrc >/dev/null 2>&1 || true'

echo "==> Inspecting $target"
remote_home="$(ssh "$target" 'printf "%s" "$HOME"')"
remote_arch="$(ssh "$target" 'uname -m')"
remote_dir="$remote_home/.local/bin"
remote_bin="$remote_dir/yterminal-agent"
remote_tmp="$remote_dir/.yterminal-agent-dev-$$"

if ssh "$target" "zsh -lc '$remote_cmd_prefix; command -v cargo >/dev/null 2>&1'"; then
  echo "==> Remote cargo found; syncing source and building on $target"
  remote_work="$remote_home/.cache/yterminal-agent-dev/src"
  ssh "$target" "rm -rf '$remote_work' && mkdir -p '$remote_work'"
  rsync -a --delete \
    --exclude .git \
    --exclude node_modules \
    --exclude dist \
    --exclude 'src-tauri/target*' \
    "$repo_root/" "$target:$remote_work/"
  ssh "$target" "zsh -lc '$remote_cmd_prefix; cd \"$remote_work\" && cargo build --manifest-path agent-cli/Cargo.toml --bin yterminal-agent'"
  agent_source="$remote_work/agent-cli/target/debug/yterminal-agent"
  install_command="install -m 755 '$agent_source' '$remote_bin'"
else
  case "$remote_arch" in
    aarch64|arm64)
      docker_platform="linux/arm64"
      target_dir="target-agent-linux-arm64"
      ;;
    x86_64|amd64)
      docker_platform="linux/amd64"
      target_dir="target-agent-linux-amd64"
      ;;
    *)
      echo "Unsupported remote architecture: $remote_arch" >&2
      exit 1
      ;;
  esac
  echo "==> Remote cargo not found; building Linux agent with Docker ($docker_platform)"
  docker run --rm \
    --platform "$docker_platform" \
    --user "$(id -u):$(id -g)" \
    -e CARGO_HOME=/tmp/cargo \
    -e CARGO_TARGET_DIR="/work/agent-cli/$target_dir" \
    -v "$repo_root":/work \
    -w /work \
    rust:1-bookworm \
    cargo build --manifest-path agent-cli/Cargo.toml --bin yterminal-agent
  agent_bin="$repo_root/agent-cli/$target_dir/debug/yterminal-agent"
  install_command="chmod +x '$remote_tmp' && mv '$remote_tmp' '$remote_bin'"
fi

ssh "$target" "mkdir -p '$remote_dir'"

if [ -n "${agent_bin:-}" ]; then
  echo "==> Uploading agent to $target:$remote_bin"
  scp "$agent_bin" "$target:$remote_tmp"
fi
ssh "$target" "$install_command"

echo "==> Installing and restarting remote agent"
ssh "$target" "'$remote_bin' version"
ssh "$target" "'$remote_bin' install"
ssh "$target" "'$remote_bin' restart"

echo "==> Verifying remote agent"
ssh "$target" "'$remote_bin' status"
ssh "$target" "'$remote_bin' ping"
ssh "$target" "'$remote_bin' sessions --json"
ssh "$target" "'$remote_bin' smoke --json"
ssh "$target" "'$remote_bin' status"
ssh "$target" "'$remote_bin' sessions --json"

echo "==> Remote agent flow complete: $target"
