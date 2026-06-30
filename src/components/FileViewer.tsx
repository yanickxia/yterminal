import { useEffect, useMemo, useState } from "react";
import { useViewerStore } from "../stores/viewer-store";
import { renderMarkdown, highlightCode } from "../lib/file-render";
import { basename } from "../lib/file-link-classify";

/**
 * Read-only built-in file viewer modal, driven by `useViewerStore`. Opens when
 * a clicked terminal path classifies as a viewable text/code/markdown file.
 * Markdown is rendered to sanitized HTML; everything else is shown as
 * syntax-highlighted source. A "Raw" toggle drops back to plain monospace text
 * (useful for markdown, or when highlighting is unhelpful).
 */
export function FileViewer() {
  const open = useViewerStore((s) => s.open);
  const path = useViewerStore((s) => s.path);
  const language = useViewerStore((s) => s.language);
  const markdown = useViewerStore((s) => s.markdown);
  const text = useViewerStore((s) => s.text);
  const loading = useViewerStore((s) => s.loading);
  const error = useViewerStore((s) => s.error);
  const close = useViewerStore((s) => s.close);

  // "Raw" shows the unrendered/unhighlighted source. Reset to the default
  // (rendered) view whenever a different file is opened.
  const [raw, setRaw] = useState(false);
  useEffect(() => {
    setRaw(false);
  }, [path]);

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Memoize the (potentially heavy) render so it doesn't re-run on every
  // unrelated store change. Only markdown/highlighted views compute HTML.
  const html = useMemo(() => {
    if (loading || error || raw) return null;
    if (markdown) return renderMarkdown(text);
    return highlightCode(text, language);
  }, [loading, error, raw, markdown, text, language]);

  if (!open) return null;

  const name = path ? basename(path) : "";

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal file-viewer"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="file-viewer-title" title={path ?? ""}>
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
            <button className="icon-btn" title="Close" onClick={close}>
              ×
            </button>
          </div>
        </div>

        <div className="modal-body file-viewer-body">
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
    </div>
  );
}
