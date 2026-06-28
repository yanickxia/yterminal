// system-fonts: detect which monospace fonts are actually installed on the
// machine, so the Settings font picker can offer real system fonts beyond the
// handful of built-in presets.
//
// Why canvas detection (and not a native API)?
//   - The Local Font Access API (`queryLocalFonts()`) is Chromium-only; the
//     macOS WKWebView and Linux WebKitGTK that Tauri uses don't expose it.
//   - A native crate (font-kit) pulls in fontconfig/freetype, complicating the
//     Linux build for no real gain here.
// Canvas text-measurement works in every WebView with zero dependencies: we
// render a probe string in a generic family, then in `"Candidate", generic`.
// If the width changes, the candidate font is installed.

import type { FontOption } from "./themes";

// A broad catalog of popular monospace fonts across macOS / Windows / Linux and
// common developer installs. Only the ones actually present get surfaced.
const CANDIDATES: string[] = [
  // macOS
  "Menlo",
  "Monaco",
  "SF Mono",
  "SFMono-Regular",
  "Andale Mono",
  "PT Mono",
  "Courier",
  "Courier New",
  // Windows
  "Consolas",
  "Cascadia Code",
  "Cascadia Mono",
  "Lucida Console",
  // Linux
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Ubuntu Mono",
  "Noto Sans Mono",
  "Inconsolata",
  "Droid Sans Mono",
  // popular cross-platform developer fonts
  "JetBrains Mono",
  "JetBrainsMono Nerd Font",
  "Fira Code",
  "Fira Mono",
  "Hack",
  "Hack Nerd Font",
  "Source Code Pro",
  "IBM Plex Mono",
  "Roboto Mono",
  "Space Mono",
  "Anonymous Pro",
  "Victor Mono",
  "Iosevka",
  "MesloLGS NF",
  "Meslo LG S",
  "Operator Mono",
  "Comic Mono",
  "Monaspace Neon",
  "Monaspace Argon",
  "Monaspace Xenon",
  "Monaspace Radon",
  "Monaspace Krypton",
  "Geist Mono",
  "Maple Mono",
  "0xProto",
  "Departure Mono",
  "Berkeley Mono",
];

const TEST_STRING = "mmmmmmmmmmlli0Oo1234567890wWiI";
const TEST_PX = "72px";
const BASE_FAMILIES = ["monospace", "serif", "sans-serif"];

let ctx: CanvasRenderingContext2D | null = null;
function getCtx(): CanvasRenderingContext2D | null {
  if (ctx) return ctx;
  if (typeof document === "undefined") return null;
  ctx = document.createElement("canvas").getContext("2d");
  return ctx;
}

function widthOf(fontStack: string): number {
  const c = getCtx();
  if (!c) return 0;
  c.font = `${TEST_PX} ${fontStack}`;
  return c.measureText(TEST_STRING).width;
}

/** True if `family` is installed (its metrics differ from a generic fallback). */
function isInstalled(family: string): boolean {
  const quoted = `"${family}"`;
  for (const base of BASE_FAMILIES) {
    if (widthOf(`${quoted}, ${base}`) !== widthOf(base)) return true;
  }
  return false;
}

/**
 * Probe the candidate list and return FontOptions for the installed ones.
 * The id is the family name itself; the stack falls back to `monospace`.
 */
export function detectSystemFonts(): FontOption[] {
  const found: FontOption[] = [];
  for (const family of CANDIDATES) {
    if (isInstalled(family)) {
      found.push({ id: family, name: family, stack: `"${family}", monospace` });
    }
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}
