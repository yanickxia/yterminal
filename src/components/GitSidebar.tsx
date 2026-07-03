// GitSidebar: a left-of-AI panel that shows, for the active tab's working
// directory, the current branch and the set of changed files (staged +
// unstaged + untracked) with per-file line deltas — the "Changes" view an IDE
// gives you. Driven by git-store, which recomputes on tab switch / focus. When
// the cwd isn't a git repo it renders a quiet placeholder.

import { useGitStore } from "../stores/git-store";
import { useLayoutStore } from "../stores/layout-store";
import { changeKind, splitPath, type GitFile } from "../lib/git";

/** Short single-letter badge for a file's change kind. */
function badge(f: GitFile): { char: string; kind: string } {
  const kind = changeKind(f.status);
  const char =
    kind === "added" || kind === "untracked"
      ? "A"
      : kind === "deleted"
        ? "D"
        : kind === "renamed"
          ? "R"
          : "M";
  return { char, kind };
}

export function GitSidebar() {
  const status = useGitStore((s) => s.status);
  const loading = useGitStore((s) => s.loading);
  const cwd = useGitStore((s) => s.cwd);
  const refresh = useGitStore((s) => s.refresh);
  const setOpen = useGitStore((s) => s.setOpen);
  const gitWidth = useLayoutStore((s) => s.gitWidth);

  return (
    <div className="git-sidebar" style={{ width: gitWidth, minWidth: gitWidth }}>
      <div className="git-sidebar-head">
        <span className="git-sidebar-title">Source Control</span>
        <div className="git-sidebar-head-actions">
          <button
            className="link-btn"
            onClick={() => void refresh()}
            title="Refresh git status"
          >
            refresh
          </button>
          <button
            className="icon-btn"
            onClick={() => setOpen(false)}
            title="Close git sidebar"
          >
            ×
          </button>
        </div>
      </div>

      {!status.isRepo ? (
        <div className="git-sidebar-empty">
          {cwd
            ? "Not a git repository."
            : "No active terminal to inspect."}
        </div>
      ) : (
        <>
          <div className="git-branch" title={status.root}>
            <span className="git-branch-icon" aria-hidden="true">
              ⑂
            </span>
            <span className="git-branch-name">{status.branch || "—"}</span>
          </div>
          <div className="git-changes-label">
            Changes
            {status.files.length > 0 ? ` (${status.files.length})` : ""}
          </div>
          <div className="git-file-list">
            {status.files.length === 0 ? (
              <div className="git-sidebar-empty">
                {loading ? "Loading…" : "No changes."}
              </div>
            ) : (
              status.files.map((f) => {
                const { name, dir } = splitPath(f.path);
                const b = badge(f);
                return (
                  <div
                    key={f.path}
                    className="git-file"
                    title={f.path}
                  >
                    <span className={`git-file-badge git-badge-${b.kind}`}>
                      {b.char}
                    </span>
                    <span className="git-file-text">
                      <span className="git-file-name">{name}</span>
                      {dir && <span className="git-file-dir">{dir}</span>}
                    </span>
                    {(f.insertions > 0 || f.deletions > 0) && (
                      <span className="git-file-stat">
                        {f.insertions > 0 && (
                          <span className="git-stat-add">+{f.insertions}</span>
                        )}
                        {f.deletions > 0 && (
                          <span className="git-stat-del">−{f.deletions}</span>
                        )}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
