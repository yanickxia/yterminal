import { useEffect, useMemo, useRef, useState } from "react";
import { useViewerStore } from "../stores/viewer-store";
import { renderMarkdown, highlightCode } from "../lib/file-render";
import { basename } from "../lib/file-link-classify";
import { clipboardWrite } from "../lib/clipboard";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import type { TabFile } from "../lib/types";

/**
 * Read-only built-in file viewer rendered *inside a tab* (not a modal). The
 * durable descriptor (path/language/markdown) lives on the Tab; the file text
 * is loaded lazily into `useViewerStore`, keyed by tab id, the first time the
 * tab renders. Markdown is rendered to sanitized HTML; everything else is shown
 * as syntax-highlighted source. A "Raw" toggle drops back to plain monospace
 * text (useful for markdown, or when highlighting is unhelpful).
 */
export function FileViewer({ tabId, file }: { tabId: string; file: TabFile }) {
  const { path, language, markdown } = file;
  const load = useViewerStore((s) => s.load);
  const state = useViewerStore((s) => s.files[tabId]);
  const text = state?.text ?? "";
  const loading = state?.loading ?? true;
  const error = state?.error ?? null;

  // Kick off (idempotent) the disk read for this tab/path.
  useEffect(() => {
    void load(tabId, path);
  }, [tabId, path, load]);

  // "Raw" shows the unrendered/unhighlighted source. Reset to the default
  // (rendered) view whenever a different file is shown.
  const [raw, setRaw] = useState(false);
  useEffect(() => {
    setRaw(false);
  }, [path]);

  // Overflow "…" menu anchored to its trigger button (Copy full path / content).
  const moreBtn = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  function openMenu() {
    const r = moreBtn.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.right, y: r.bottom + 4 });
  }

  const menuItems: MenuItem[] = [
    {
      label: "Copy full path",
      disabled: !path,
      onClick: () => void clipboardWrite(path).catch(() => {}),
    },
    {
      label: "Copy content",
      disabled: loading || !!error || !text,
      onClick: () => void clipboardWrite(text).catch(() => {}),
    },
  ];

  // Memoize the (potentially heavy) render so it doesn't re-run on every
  // unrelated store change. Only markdown/highlighted views compute HTML.
  const html = useMemo(() => {
    if (loading || error || raw) return null;
    if (markdown) return renderMarkdown(text);
    return highlightCode(text, language);
  }, [loading, error, raw, markdown, text, language]);

  const name = path ? basename(path) : "";

  return (
    <div className="file-viewer-pane">
      <div className="file-viewer-bar">
        <span className="file-viewer-title" title={path}>
          {name || "File"}
        </span>
        <div className="file-viewer-actions">
          <button
            className="file-viewer-toggle"
            onClick={() => setRaw((r) => !r)}
            disabled={loading || !!error}
            title={raw ? "Show rendered view" : "Show raw text"}
          >
            {raw ? (markdown ? "Rendered" : "Highlighted") : "Raw"}
          </button>
          <button
            ref={moreBtn}
            className="file-viewer-toggle file-viewer-more"
            onClick={openMenu}
            title="More actions"
            aria-label="More actions"
          >
            …
          </button>
        </div>
      </div>

      {menu && (
        <ContextMenu
          items={menuItems}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}

      <div className="file-viewer-body">
        {loading && <p className="file-viewer-status">Loading…</p>}

        {!loading && error && (
          <p className="file-viewer-status file-viewer-error">{error}</p>
        )}

        {!loading && !error && raw && (
          <pre className="file-viewer-raw">{text}</pre>
        )}

        {!loading && !error && !raw && markdown && (
          <div
            className="file-viewer-markdown"
            dangerouslySetInnerHTML={{ __html: html ?? "" }}
          />
        )}

        {!loading && !error && !raw && !markdown && (
          <pre className="file-viewer-code hljs">
            <code
              className={`language-${language}`}
              dangerouslySetInnerHTML={{ __html: html ?? "" }}
            />
          </pre>
        )}
      </div>
    </div>
  );
}
