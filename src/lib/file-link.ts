// Side-effecting router for a token the user clicked in the terminal. Pure
// routing rules live in file-link-classify.ts; this module performs the IO:
// resolving the path, probing existence via the Rust backend, and dispatching
// to the in-app viewer, an external URL open, or an OS open.

import {
  isWebUrl,
  resolvePath,
  classifyFilePath,
  looksLikePath,
} from "./file-link-classify";
import { pathIsFile } from "./file-reader";
import { openUrl, openPath } from "./opener";
import { useWorkspaceStore } from "../stores/workspace-store";

/**
 * Decide what a clicked terminal token is and act on it. `cwd`/`home` resolve
 * relative and ~-prefixed paths. Returns true when the token was handled (a URL
 * opened, a file viewed/OS-opened), false when it wasn't actionable so the
 * caller can leave it alone.
 */
export async function handleClickedToken(
  token: string,
  cwd: string,
  home?: string
): Promise<boolean> {
  const trimmed = token.trim();
  if (!trimmed) return false;

  // Web URLs open externally, same as the WebLinks addon path.
  if (isWebUrl(trimmed)) {
    await openUrl(trimmed).catch((err) =>
      console.warn("openUrl failed", trimmed, err)
    );
    return true;
  }

  if (!looksLikePath(trimmed)) return false;

  const abs = resolvePath(trimmed, cwd, home);
  // Only act on paths that actually exist as a regular file. Directories and
  // missing paths are left to the OS-open fallback below would mis-handle, so
  // we simply ignore them.
  const exists = await pathIsFile(abs);
  if (!exists) return false;

  const target = classifyFilePath(abs);
  if (target.kind === "view") {
    // Open (or re-activate) a read-only file viewer tab in the active workspace.
    const store = useWorkspaceStore.getState();
    const wsId = store.activeWorkspaceId;
    if (!wsId) return false;
    store.openFileTab(wsId, {
      path: target.path,
      language: target.language,
      markdown: target.markdown,
    });
    return true;
  }
  if (target.kind === "os-open") {
    // Recognized as a file but not a viewable text type: hand to the OS.
    await openPath(target.path).catch((err) =>
      console.warn("openPath failed", target.path, err)
    );
    return true;
  }
  return false;
}
