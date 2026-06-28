import { useEffect, useRef, useState } from "react";
import {
  searchNext,
  searchPrevious,
  clearSearch,
  focusSession,
} from "../lib/terminal-manager";

/**
 * Floating in-terminal search box (Cmd/Ctrl+F). Searches the scrollback of the
 * given pane via xterm's SearchAddon, highlighting matches in the viewport.
 */
export function SearchBox({
  paneId,
  onClose,
}: {
  paneId: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // focus the field as soon as the box appears
  useEffect(() => {
    inputRef.current?.focus();
  }, [paneId]);

  // re-run the search as the query changes so highlights track typing
  useEffect(() => {
    if (query) searchNext(paneId, query);
    else clearSearch(paneId);
  }, [query, paneId]);

  function close() {
    clearSearch(paneId);
    onClose();
    focusSession(paneId);
  }

  return (
    <div className="search-box">
      <input
        ref={inputRef}
        className="search-input"
        placeholder="Search…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) searchPrevious(paneId, query);
            else searchNext(paneId, query);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      />
      <button
        className="icon-btn"
        title="Previous match (Shift+Enter)"
        onClick={() => searchPrevious(paneId, query)}
      >
        ↑
      </button>
      <button
        className="icon-btn"
        title="Next match (Enter)"
        onClick={() => searchNext(paneId, query)}
      >
        ↓
      </button>
      <button className="icon-btn" title="Close (Esc)" onClick={close}>
        ×
      </button>
    </div>
  );
}
