// GitSidebar: a left-of-AI panel that shows, for the active tab's working
// directory, the current branch and the set of changed files (staged +
// unstaged + untracked) with per-file line deltas — the "Changes" view an IDE
// gives you. Driven by git-store, which recomputes on tab switch / focus / and
// after every shell command (OSC 7). Clicking a file expands its unified diff
// inline. When the cwd isn't a git repo it renders a quiet placeholder.

import { useEffect, useRef, useState } from "react";
import { useGitStore } from "../stores/git-store";
import { useLayoutStore } from "../stores/layout-store";
import { changeKind, splitPath, gitDiff, type GitFile } from "../lib/git";

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

// A single rendered diff row. `oldNo`/`newNo` populate the gutter (null =
// blank, e.g. an added line has no old-side number). `hunk` rows span the full
// width with no gutter number; the surrounding file header is dropped entirely.
type DiffRow = {
  kind: "add" | "del" | "ctx" | "hunk";
  oldNo: number | null;
  newNo: number | null;
  text: string;
};

/** Is this a unified-diff file-header line we want to hide (IDE-style)? */
function isHeaderLine(line: string): boolean {
  return (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("rename ") ||
    line.startsWith("copy ") ||
    line.startsWith("similarity ") ||
    line.startsWith("dissimilarity ") ||
    line.startsWith("\\ No newline")
  );
}

/**
 * Parse a unified diff into gutter-numbered rows, dropping the file header and
 * tracking old/new line numbers off each `@@ -a,b +c,d @@` hunk marker.
 */
function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      rows.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
      continue;
    }
    if (isHeaderLine(line)) continue;
    if (line.startsWith("+")) {
      rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else {
      // Context line (leading space) or a trailing empty line.
      const body = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: body });
    }
  }
  // Drop lone trailing empty context rows produced by the final newline.
  while (
    rows.length &&
    rows[rows.length - 1].kind === "ctx" &&
    rows[rows.length - 1].text === ""
  ) {
    rows.pop();
  }
  return rows;
}

/** Render a unified diff as IDE-style rows with a line-number gutter. */
function DiffView({ text, loading }: { text: string; loading: boolean }) {
  if (loading) return <div className="git-diff-empty">Loading diff…</div>;
  if (!text.trim()) return <div className="git-diff-empty">No diff.</div>;
  const rows = parseDiff(text);
  return (
    <div className="git-diff">
      {rows.map((r, i) =>
        r.kind === "hunk" ? (
          <div key={i} className="git-diff-row git-diff-hunk">
            <span className="git-diff-gutter" aria-hidden="true" />
            <span className="git-diff-code">{r.text}</span>
          </div>
        ) : (
          <div key={i} className={`git-diff-row git-diff-${r.kind}`}>
            <span className="git-diff-gutter" aria-hidden="true">
              {r.newNo ?? r.oldNo ?? ""}
            </span>
            <span className="git-diff-code">{r.text || " "}</span>
          </div>
        ),
      )}
    </div>
  );
}

export function GitSidebar() {
  const status = useGitStore((s) => s.status);
  const loading = useGitStore((s) => s.loading);
  const cwd = useGitStore((s) => s.cwd);
  const refresh = useGitStore((s) => s.refresh);
  const setOpen = useGitStore((s) => s.setOpen);
  const gitWidth = useLayoutStore((s) => s.gitWidth);

  // Which file's diff is expanded, plus its (async-loaded) diff text.
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [diffText, setDiffText] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  // Monotonic guard so a slow diff load can't clobber a newer selection.
  const diffSeq = useRef(0);

  // Collapse the expanded diff whenever the repo/cwd changes out from under us,
  // so a stale diff can't linger against a different set of changes.
  useEffect(() => {
    setOpenPath(null);
    setDiffText("");
  }, [cwd, status.root]);

  // If the expanded file is no longer in the change set (e.g. it was committed
  // or reverted), close it so we don't show a diff for a vanished entry.
  useEffect(() => {
    if (openPath && !status.files.some((f) => f.path === openPath)) {
      setOpenPath(null);
      setDiffText("");
    }
  }, [status.files, openPath]);

  async function toggleFile(path: string) {
    if (openPath === path) {
      setOpenPath(null);
      setDiffText("");
      return;
    }
    const seq = ++diffSeq.current;
    setOpenPath(path);
    setDiffText("");
    if (!cwd) return;
    setDiffLoading(true);
    const text = await gitDiff(cwd, path);
    if (seq !== diffSeq.current) return; // superseded by a newer click
    setDiffText(text);
    setDiffLoading(false);
  }

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
                const expanded = openPath === f.path;
                return (
                  <div key={f.path} className="git-file-row">
                    <button
                      type="button"
                      className={`git-file${expanded ? " git-file-active" : ""}`}
                      title={f.path}
                      onClick={() => void toggleFile(f.path)}
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
                    </button>
                    {expanded && (
                      <DiffView text={diffText} loading={diffLoading} />
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
