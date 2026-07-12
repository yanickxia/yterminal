import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";

/**
 * Cmd/Ctrl+K quick switcher: fuzzy-search every (workspace, tab) pair and jump
 * to one with the keyboard. Modeled on the VSCode / Linear command palette.
 */
export function WorkspacePalette({
  onClose,
  onOpenOverview,
}: {
  onClose: () => void;
  onOpenOverview: () => void;
}) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // build flat (workspace, tab) entries. Each is one selectable row.
  const allEntries = useMemo(() => {
    const out: Array<{
      key: string;
      workspaceId: string;
      tabId: string;
      workspaceName: string;
      tabName: string;
      workspaceIcon?: string;
      isActive: boolean;
    }> = [];
    for (const w of workspaces) {
      for (const t of w.tabs) {
        out.push({
          key: `${w.id}/${t.id}`,
          workspaceId: w.id,
          tabId: t.id,
          workspaceName: w.name,
          tabName: t.name,
          workspaceIcon: w.icon,
          isActive: w.id === activeWorkspaceId && w.activeTabId === t.id,
        });
      }
    }
    return out;
  }, [workspaces, activeWorkspaceId]);

  // filter + score against the query. Empty query keeps original order, with
  // the currently-active row floated to top for one-tap-back behavior.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      const sorted = [...allEntries];
      sorted.sort((a, b) =>
        a.isActive === b.isActive ? 0 : a.isActive ? -1 : 1
      );
      return sorted;
    }
    const scored: Array<{ entry: (typeof allEntries)[number]; score: number }> = [];
    for (const e of allEntries) {
      const hay = `${e.workspaceName} ${e.tabName}`.toLowerCase();
      const score = subsequenceScore(hay, q);
      if (score !== null) scored.push({ entry: e, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.entry);
  }, [allEntries, query]);

  // reset selection whenever the result set changes
  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // keep the active row scrolled into view as the cursor moves
  useEffect(() => {
    const el = listRef.current?.children[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function jumpTo(workspaceId: string, tabId: string) {
    if (workspaceId !== activeWorkspaceId) setActiveWorkspace(workspaceId);
    setActiveTab(workspaceId, tabId);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = matches[cursor];
      if (pick) jumpTo(pick.workspaceId, pick.tabId);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (matches.length ? (c + 1) % matches.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) =>
        matches.length ? (c - 1 + matches.length) % matches.length : 0
      );
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Jump to workspace / tab…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {/* Mouse-only: the keyboard cursor intentionally indexes only palette-list tab rows. */}
        <div className="palette-actions">
          <div
            className="palette-row palette-action"
            onMouseDown={(e) => {
              e.preventDefault();
              onOpenOverview();
              onClose();
            }}
          >
            <span className="palette-icon">⤢</span>
            <span className="palette-ws">打开 Agent 透视图</span>
          </div>
        </div>
        <div className="palette-list" ref={listRef}>
          {matches.length === 0 ? (
            <div className="palette-empty">No matches</div>
          ) : (
            matches.map((m, i) => (
              <div
                key={m.key}
                className={
                  "palette-row" +
                  (i === cursor ? " active" : "") +
                  (m.isActive ? " current" : "")
                }
                onMouseEnter={() => setCursor(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  jumpTo(m.workspaceId, m.tabId);
                }}
              >
                <span className="palette-icon">{m.workspaceIcon ?? "•"}</span>
                <span className="palette-ws">{m.workspaceName}</span>
                <span className="palette-sep">›</span>
                <span className="palette-tab">{m.tabName}</span>
                {m.isActive && <span className="palette-badge">current</span>}
              </div>
            ))
          )}
        </div>
        <div className="palette-hint">
          ↑↓ navigate · ↵ jump · esc close
        </div>
      </div>
    </div>
  );
}

/**
 * Lightweight fuzzy score: every character of `needle` must appear in `hay`
 * in order. Score rewards contiguous matches and prefix matches. Returns null
 * if the needle can't be threaded through the haystack.
 */
function subsequenceScore(hay: string, needle: string): number | null {
  let score = 0;
  let hi = 0;
  let lastMatch = -2;
  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni];
    let found = -1;
    for (; hi < hay.length; hi++) {
      if (hay[hi] === ch) {
        found = hi;
        break;
      }
    }
    if (found === -1) return null;
    score += 10;
    if (found === lastMatch + 1) score += 8; // contiguous bonus
    if (found === 0) score += 5; // prefix bonus
    lastMatch = found;
    hi = found + 1;
  }
  // shorter haystacks rank higher when otherwise tied
  return score - hay.length * 0.1;
}
