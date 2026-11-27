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
