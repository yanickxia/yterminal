// GitSidebar: a left-of-AI panel that shows, for the active tab's working
// directory, the current branch and the set of changed files (staged +
// unstaged + untracked) with per-file line deltas — the "Changes" view an IDE
// gives you. Driven by git-store, which recomputes on tab switch / focus / and
// after every shell command (OSC 7). Clicking a file expands its unified diff
// inline. When the cwd isn't a git repo it renders a quiet placeholder.

import { useEffect, useRef, useState } from "react";
import { useGitStore } from "../stores/git-store";
import { useLayoutStore } from "../stores/layout-store";
import {
  changeKind,
  splitPath,
  gitDiff,
  listEditors,
  openInEditor,
  type GitFile,
  type EditorInfo,
} from "../lib/git";

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

/**
 * Brand icon for an editor id. Returns a compact 16×16 SVG so the "Open with"
 * menu reads as icon + name. Falls back to a neutral generic glyph for any id
 * not in the catalog.
 */
function EditorIcon({ id }: { id: string }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    "aria-hidden": true,
    className: "git-openwith-icon",
  } as const;
  switch (id) {
    case "vscode":
      return (
        <svg {...common}>
          <path
            fill="#0098FF"
            d="M17.6 2.3 10.3 9 5.9 5.7 4 6.6l3.4 3.9L4 14.4l1.9.9 4.4-3.3 7.3 6.7L21 17V4.7L17.6 2.3ZM17.7 6.9v8.6l-5.4-4.3 5.4-4.3Z"
          />
        </svg>
      );
    case "cursor":
      return (
        <svg {...common}>
          <path fill="#9CA3AF" d="M4 3v18l7-6 3 6 3-1.4-2.9-5.8H21L4 3Z" />
        </svg>
      );
    case "zed":
      return (
        <svg {...common}>
          <path
            fill="#0E7C66"
            d="M3 3h18v6h-2V5H8.4l10.6 8.6V21H3v-6h2v4h10.6L5 10.4V3Z"
          />
        </svg>
      );
    case "sublime":
      return (
        <svg {...common}>
          <path fill="#FF9800" d="M20 4 6 8.3v3.4L18 8v3.9L6 15.6V19l14-4.3v-3.4L8 15v-3.9L20 7.4V4Z" />
        </svg>
      );
    case "idea":
      return (
        <svg {...common}>
          <path fill="#FE315D" d="M3 3h18v18H3V3Zm2.5 13.5h6V18h-6v-1.5ZM6 6v9l2.2-.8V7.6l1.6-.4V6H6Zm7 0v2h1.5v6H13v2h5v-2h-1.5V8H18V6h-5Z" />
        </svg>
      );
    case "webstorm":
      return (
        <svg {...common}>
          <path fill="#07C3F2" d="M3 3h18v18H3V3Zm2.5 13.5h6V18h-6v-1.5ZM5.5 7l1.4 5 1.2-3.6L9.3 12l1.4-5H9.2l-.7 3-1-3H6.2l-1 3-.7-3H3.2L5.5 7Z" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path
            fill="currentColor"
            d="M4 5h16v14H4V5Zm2 2v10h12V7H6Zm2 2h5v2H8V9Zm0 4h8v2H8v-2Z"
          />
        </svg>
      );
  }
}

/**
 * "Open with" dropdown: lists external editors detected on the machine and
 * launches the given `dir` (the repo root) in the chosen one. Renders nothing
 * when no editors are installed. The editor list is fetched once on mount and
 * cached for the component's lifetime.
 */
function OpenWithMenu({ dir }: { dir: string }) {
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void listEditors().then((es) => {
      if (alive) setEditors(es);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Close the menu on any outside click while it's open.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (editors.length === 0) return null;

  return (
    <div className="git-openwith" ref={wrapRef}>
      <button
        type="button"
        className="link-btn"
        onClick={() => setOpen((v) => !v)}
        title="Open this repository in an external editor"
      >
        open with ▾
      </button>
      {open && (
        <div className="git-openwith-menu" role="menu">
          {editors.map((e) => (
            <button
              key={e.id}
              type="button"
              className="git-openwith-item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void openInEditor(e.id, dir);
              }}
            >
              <EditorIcon id={e.id} />
              <span className="git-openwith-label">{e.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function GitSidebar() {
  const status = useGitStore((s) => s.status);
  const loading = useGitStore((s) => s.loading);
  const cwd = useGitStore((s) => s.cwd);
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
          {status.isRepo && status.root && <OpenWithMenu dir={status.root} />}
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
