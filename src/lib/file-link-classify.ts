// Pure classification of a token a user clicked in the terminal: is it a web
// URL, a viewable text/code file, or something we should hand to the OS? No IO
// here — path existence is checked by the caller (file-link.ts) via the Rust
// backend. Keeping this pure makes the routing rules fully unit-testable.

/** What the caller should do with a clicked token. */
export type LinkTarget =
  | { kind: "url"; url: string }
  | { kind: "view"; path: string; language: string; markdown: boolean }
  | { kind: "os-open"; path: string };

/**
 * Extensions we render inside the built-in viewer, mapped to the highlight.js
 * language id used for syntax highlighting. Markdown is special-cased to render
 * as HTML rather than highlight, so it's flagged separately in `MARKDOWN_EXTS`.
 */
const VIEW_EXT_LANGUAGE: Record<string, string> = {
  // markdown (rendered, not highlighted — language kept for the raw toggle)
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  // plain text / data
  txt: "plaintext",
  text: "plaintext",
  log: "plaintext",
  csv: "plaintext",
  tsv: "plaintext",
  env: "plaintext",
  // structured config
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  conf: "ini",
  xml: "xml",
  html: "xml",
  htm: "xml",
  // sql
  sql: "sql",
  // common code
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  css: "css",
  scss: "scss",
  less: "less",
  vue: "xml",
  svelte: "xml",
  dockerfile: "dockerfile",
  makefile: "makefile",
  gradle: "gradle",
  diff: "diff",
  patch: "diff",
};

/** Subset of viewable extensions that should be rendered as Markdown. */
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

/** Bare filenames (no extension) that are still text and worth viewing. */
const VIEWABLE_BASENAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  readme: "plaintext",
  license: "plaintext",
  ".gitignore": "plaintext",
  ".gitconfig": "ini",
  ".env": "plaintext",
  ".bashrc": "bash",
  ".zshrc": "bash",
};

/** Lowercased final path segment. */
export function basename(path: string): string {
  const cleaned = path.replace(/[/\\]+$/, "");
  const slash = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return slash === -1 ? cleaned : cleaned.slice(slash + 1);
}

/** Lowercased extension WITHOUT the dot, or "" when there is none. */
export function extname(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  // a leading dot (dotfile) is not an extension separator.
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** True for http:// and https:// URLs (the only schemes we open externally). */
export function isWebUrl(token: string): boolean {
  return /^https?:\/\//i.test(token.trim());
}

/**
 * Decide how to render a viewable file path: which highlight.js language, and
 * whether it should be Markdown-rendered. Returns null when the path is not a
 * recognized text type (caller then OS-opens it).
 */
export function classifyViewable(
  path: string
): { language: string; markdown: boolean } | null {
  const ext = extname(path);
  if (ext && ext in VIEW_EXT_LANGUAGE) {
    return { language: VIEW_EXT_LANGUAGE[ext], markdown: MARKDOWN_EXTS.has(ext) };
  }
  const base = basename(path).toLowerCase();
  if (base in VIEWABLE_BASENAMES) {
    return { language: VIEWABLE_BASENAMES[base], markdown: false };
  }
  return null;
}

/**
 * Classify a clicked path that is already known to exist as a file. Web URLs
 * are handled separately by the caller (they aren't filesystem paths). A
 * recognized text/code/markdown type opens in the built-in viewer; anything
 * else is handed to the OS.
 */
export function classifyFilePath(path: string): LinkTarget {
  const viewable = classifyViewable(path);
  if (viewable) {
    return {
      kind: "view",
      path,
      language: viewable.language,
      markdown: viewable.markdown,
    };
  }
  return { kind: "os-open", path };
}

/**
 * Resolve a (possibly relative or ~-prefixed) path against the pane's cwd and
 * home directory into an absolute path. Pure string math — does not touch the
 * filesystem. Returns the input unchanged when it's already absolute.
 */
export function resolvePath(
  raw: string,
  cwd: string,
  home?: string
): string {
  let p = raw.trim();
  // strip a trailing colon+line-number like "file.ts:42" or "file.ts:42:9"
  p = p.replace(/(:\d+)+$/, "");
  if (!p) return raw;
  // ~ or ~/...
  if (home && (p === "~" || p.startsWith("~/"))) {
    p = home.replace(/\/+$/, "") + p.slice(1);
  }
  // already absolute (unix or windows drive / UNC)
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\")) {
    return p;
  }
  // join against cwd, then collapse . and .. segments.
  const baseSep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  const joined = cwd.replace(/[/\\]+$/, "") + baseSep + p;
  return normalizeSegments(joined, baseSep);
}

/** Collapse "." and ".." segments in a path string (no IO). */
function normalizeSegments(path: string, sep: string): string {
  const isAbs = path.startsWith("/");
  const parts = path.split(/[/\\]+/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join(sep);
  return isAbs ? sep + joined : joined;
}

/**
 * Heuristic: does a clicked token even look like a filesystem path worth
 * probing? Filters out obvious noise (empty, pure numbers, things with spaces)
 * so we don't stat junk for every click.
 */
export function looksLikePath(token: string): boolean {
  const t = token.trim().replace(/(:\d+)+$/, "");
  if (!t || /\s/.test(t)) return false;
  if (isWebUrl(t)) return false;
  // must contain a path separator, a dot-extension, or be a known bare name.
  if (t.includes("/") || t.includes("\\")) return true;
  if (extname(t)) return true;
  if (basename(t).toLowerCase() in VIEWABLE_BASENAMES) return true;
  return false;
}

/** A path-like span found in a line of terminal text. `start`/`end` are
 *  0-based character offsets into the line, `end` exclusive. */
export interface PathSpan {
  token: string;
  start: number;
  end: number;
}

/**
 * Trailing punctuation that commonly hugs a path in prose and must be trimmed:
 * ASCII sentence punctuation plus the CJK full-width equivalents (。，、；：！？
 * and full-width brackets/quotes) — Chinese/Japanese prose puts these flush
 * against a path with no space, so a `\S+` chunk would otherwise swallow them
 * and the file probe would fail on the stray trailing glyph.
 */
const TRAIL_PUNCT = "\"'`)]}>,.;:。，、；：！？）】》」』’”";
const LEAD_PUNCT = "\"'`([{<（【《「『‘“";

/**
 * Scan a single line of terminal text for path-like tokens, returning their
 * character spans. Pure (no IO): the caller probes existence before turning a
 * span into a real link. Tokens are split on whitespace; surrounding quotes,
 * brackets and trailing punctuation are trimmed, and a trailing `:line[:col]`
 * suffix is kept as part of the token (resolvePath strips it later) so editor
 * style `file.ts:42` references stay clickable.
 */
export function findPathSpans(line: string): PathSpan[] {
  const spans: PathSpan[] = [];
  // Walk whitespace-delimited chunks, tracking absolute offsets.
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const chunk = m[0];
    const chunkStart = m.index;
    // Trim wrapping punctuation that commonly hugs a path in prose/output:
    // quotes, parens/brackets, and trailing sentence punctuation. Track how
    // much we trimmed from the left so offsets stay accurate.
    let lead = 0;
    let core = chunk;
    while (core.length && LEAD_PUNCT.includes(core[0])) {
      core = core.slice(1);
      lead++;
    }
    while (
      core.length &&
      TRAIL_PUNCT.includes(core[core.length - 1])
    ) {
      // keep a `:digits` suffix (line/col) — only strip trailing punctuation
      // that isn't part of a :line:col reference.
      if (core[core.length - 1] === ":" && /:\d/.test(core)) break;
      core = core.slice(0, -1);
    }
    if (!core) continue;
    if (isWebUrl(core)) continue; // URLs handled by the WebLinks addon
    if (!looksLikePath(core)) continue;
    const start = chunkStart + lead;
    spans.push({ token: core, start, end: start + core.length });
  }
  return spans;
}
