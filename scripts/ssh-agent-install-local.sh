# The host probe and installer are shared with the desktop's automatic setup.
probe=$(ssh -n -T -o ConnectTimeout=8 -- "$target" "$probe_command")
status=$(printf '%s\n' "$probe" | sed -n 's/^yterminal-bootstrap //p')
case "$status" in
    present)
        printf 'Agent already installed on %s. Retry Connect / Test in yterminal.\n' "$target"
        exit 0
        ;;
    "missing Linux x86_64"|"missing Linux amd64") platform=linux_x86_64 ;;
    "missing Linux aarch64"|"missing Linux arm64") platform=linux_aarch64 ;;
    "missing Darwin x86_64"|"missing Darwin arm64"|"missing Darwin aarch64") platform=macos_universal ;;
    *) printf 'Could not select a published Agent for %s (%s).\n' "$target" "$status" >&2; exit 1 ;;
esac

asset="yterminal-agent_${version}_${platform}.tar.gz"
workdir=$(mktemp -d "${TMPDIR:-/tmp}/yterminal-agent.XXXXXXXX")
trap 'rm -rf "$workdir"' EXIT
trap 'exit 1' HUP INT TERM
archive=${YTERMINAL_AGENT_ARCHIVE:-"$workdir/$asset"}
printf 'Selected %s\n' "$asset"
if [ -z "${YTERMINAL_AGENT_ARCHIVE:-}" ]; then
    curl --fail --show-error --location --proto '=https' --proto-redir '=https' \
        --connect-timeout 10 --output "$archive" "$release_url/download/v$version/$asset"
fi
if [ -n "${YTERMINAL_AGENT_SHA256:-}" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
        digest=$(sha256sum < "$archive")
    else
        digest=$(shasum -a 256 < "$archive")
    fi
    if [ "${digest%% *}" != "$YTERMINAL_AGENT_SHA256" ]; then
        printf 'Agent archive SHA-256 mismatch.\n' >&2
        exit 1
    fi
fi
if [ "$(tar -tzf "$archive")" != yterminal-agent ]; then
    printf 'Expected a standalone yterminal-agent archive.\n' >&2
    exit 1
fi
binary="$workdir/yterminal-agent"
tar -xOzf "$archive" yterminal-agent > "$binary"
size=$(wc -c < "$binary" | tr -d '[:space:]')
ssh -T -o ConnectTimeout=8 -- "$target" "$install_command $size $version" < "$binary"
ssh -n -T -o ConnectTimeout=8 -- "$target" '~/.local/bin/yterminal-agent ping'
printf 'Agent ready on %s. Retry Connect / Test in yterminal.\n' "$target"
