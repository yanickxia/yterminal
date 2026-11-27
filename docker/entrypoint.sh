#!/bin/bash
set -euo pipefail
umask 077

mkdir -p "$HOME/.config/yterminal"
export YTERMINAL_WEB_TOKEN_FILE="$HOME/.config/yterminal/web-token"

web_pid=""
env -u YTERMINAL_WEB_TOKEN yterminal-agent daemon &
agent_pid=$!
cleanup() {
    if [[ -n "$web_pid" ]]; then
        kill "$web_pid" 2>/dev/null || true
    fi
    kill "$agent_pid" 2>/dev/null || true
    wait || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT

for attempt in {1..100}; do
    if yterminal-agent ping >/dev/null 2>&1; then
        break
    fi
    kill -0 "$agent_pid"
    if [[ "$attempt" == 100 ]]; then
        echo "Agent did not become ready" >&2
        exit 1
    fi
    sleep 0.1
done

yterminal-web &
web_pid=$!
wait -n "$agent_pid" "$web_pid"
