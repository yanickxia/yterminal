#!/usr/bin/env bash
#
# bump-version.sh — set the app version in all manifests at once and,
# optionally, commit + tag + push to trigger the release workflow.
#
# Usage:
#   scripts/bump-version.sh <version> [--tag] [--push]
#
#   <version>   semver without the leading "v", e.g. 0.2.0
#   --tag       create a git commit + annotated tag v<version>
#   --push      push the current branch and the tag to origin (implies --tag)
#
# Examples:
#   scripts/bump-version.sh 0.2.0            # just rewrite the manifests
#   scripts/bump-version.sh 0.2.0 --tag      # rewrite + commit + tag locally
#   scripts/bump-version.sh 0.2.0 --push     # rewrite + commit + tag + push
#
set -euo pipefail

# ---- locate repo root (this script lives in <root>/scripts) ----
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ---- parse args ----
VERSION="${1:-}"
DO_TAG=false
DO_PUSH=false
shift || true
for arg in "$@"; do
  case "$arg" in
    --tag)  DO_TAG=true ;;
    --push) DO_TAG=true; DO_PUSH=true ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "Usage: scripts/bump-version.sh <version> [--tag] [--push]" >&2
  exit 1
fi

# ---- validate semver (X.Y.Z, optional -prerelease) ----
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Error: '$VERSION' is not a valid semver (expected e.g. 0.2.0)" >&2
  exit 1
fi

PKG_JSON="package.json"
TAURI_CONF="src-tauri/tauri.conf.json"
CARGO_TOML="src-tauri/Cargo.toml"

for f in "$PKG_JSON" "$TAURI_CONF" "$CARGO_TOML"; do
  [[ -f "$f" ]] || { echo "Error: missing $f" >&2; exit 1; }
done

# ---- guard: clean working tree when tagging ----
if $DO_TAG && [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is dirty; commit or stash before --tag/--push." >&2
  exit 1
fi

# ---- rewrite the manifests with Python (safe JSON + scoped TOML edit) ----
AGENT_CARGO_TOML="agent-cli/Cargo.toml"

for f in "$AGENT_CARGO_TOML"; do
  [[ -f "$f" ]] || { echo "Error: missing $f" >&2; exit 1; }
done

VERSION="$VERSION" python3 - "$PKG_JSON" "$TAURI_CONF" "$CARGO_TOML" "$AGENT_CARGO_TOML" <<'PY'
import json, os, re, sys

version = os.environ["VERSION"]
pkg_json, tauri_conf, cargo_toml, agent_cargo_toml = sys.argv[1:5]

def set_json_version(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    old = data.get("version")
    data["version"] = version
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"  {path}: {old} -> {version}")

def set_cargo_version(path):
    """Replace `version = "..."` only within the [package] section."""
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    in_pkg = False
    done = False
    old = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_pkg = stripped == "[package]"
            continue
        if in_pkg and not done:
            m = re.match(r'^(version\s*=\s*")([^"]*)(".*)$', line)
            if m:
                old = m.group(2)
                lines[i] = f"{m.group(1)}{version}{m.group(3)}\n"
                done = True
    if not done:
        raise SystemExit(f"Error: no version under [package] in {path}")
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines)
    print(f"  {path}: {old} -> {version}")

print("Updating versions:")
set_json_version(pkg_json)
set_json_version(tauri_conf)
set_cargo_version(cargo_toml)
set_cargo_version(agent_cargo_toml)
PY

# keep Cargo.lock's own package entry in sync (best effort, non-fatal)
if [[ -f src-tauri/Cargo.lock ]] && command -v cargo >/dev/null 2>&1; then
  ( cd src-tauri && cargo update -p yterminal --precise "$VERSION" >/dev/null 2>&1 ) || true
fi
if [[ -f agent-cli/Cargo.lock ]] && command -v cargo >/dev/null 2>&1; then
  ( cd agent-cli && cargo update -p yterminal --precise "$VERSION" >/dev/null 2>&1 ) || true
fi

echo "Done. Manifests now at $VERSION."

if ! $DO_TAG; then
  echo "Next: review the diff, then re-run with --tag or --push to release."
  exit 0
fi

# ---- commit + tag ----
TAG="v$VERSION"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag $TAG already exists." >&2
  exit 1
fi

git add "$PKG_JSON" "$TAURI_CONF" "$CARGO_TOML" "$AGENT_CARGO_TOML" src-tauri/Cargo.lock agent-cli/Cargo.lock 2>/dev/null || \
  git add "$PKG_JSON" "$TAURI_CONF" "$CARGO_TOML" "$AGENT_CARGO_TOML"
git commit -m "chore: release $TAG"
git tag -a "$TAG" -m "yterminal $TAG"
echo "Created commit + tag $TAG."

if $DO_PUSH; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  git push origin "$BRANCH"
  git push origin "$TAG"
  echo "Pushed $BRANCH and $TAG. The release workflow will start on GitHub."
else
  echo "Next: git push origin <branch> && git push origin $TAG"
fi
