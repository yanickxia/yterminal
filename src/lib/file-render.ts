// Rendering helpers for the built-in file viewer: Markdown → sanitized HTML,
// and source text → syntax-highlighted HTML. Kept out of the component so the
// transforms can be unit-tested and the (heavyish) libraries are imported in
// one place.

import { marked } from "marked";
import hljs from "highlight.js";
import DOMPurify from "dompurify";

/**
 * Render Markdown to sanitized HTML. We sanitize because the source is an
 * arbitrary on-disk file the user clicked — it must never be able to run
 * script or inject active content into our WebView.
 */
export function renderMarkdown(src: string): string {
  const raw = marked.parse(src, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(raw);
}

/**
 * Highlight source text for the given highlight.js language, returning HTML for
 * the inner <code>. Falls back to auto-detection for an unknown language and to
 * escaped plain text if highlighting throws. The output is escaped/structural
 * HTML from hljs (no raw passthrough), so it's safe to inject.
 */
export function highlightCode(src: string, language: string): string {
  try {
    if (language && language !== "plaintext" && hljs.getLanguage(language)) {
      return hljs.highlight(src, { language }).value;
    }
    if (language === "plaintext") return escapeHtml(src);
    return hljs.highlightAuto(src).value;
  } catch {
    return escapeHtml(src);
  }
}

/** Minimal HTML escape for the plain-text fallback path. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
