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
