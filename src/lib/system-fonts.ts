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
// common developer installs (including Nerd Font / Powerline variants). Only the
// ones actually present get surfaced.
const CANDIDATES: string[] = [
  // macOS system
  "Menlo",
  "Monaco",
  "SF Mono",
  "SFMono-Regular",
  "Andale Mono",
  "PT Mono",
  "Courier",
  "Courier New",
  "Courier Prime",
  "Osaka-Mono",
  // Windows system
  "Consolas",
  "Cascadia Code",
  "Cascadia Mono",
  "Cascadia Code PL",
  "Cascadia Mono PL",
  "Lucida Console",
  "Lucida Sans Typewriter",
  "Terminal",
  "Fixedsys",
  "OCR A Extended",
  // Linux system / distro defaults
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Ubuntu Mono",
  "Noto Sans Mono",
  "Noto Mono",
  "Inconsolata",
  "Inconsolata-g",
  "Droid Sans Mono",
  "FreeMono",
  "Nimbus Mono PS",
  "Bitstream Vera Sans Mono",
  "Hack",
  "Go Mono",
  "Cousine",
  "Tlwg Mono",
  // popular cross-platform developer fonts
  "JetBrains Mono",
  "JetBrainsMono Nerd Font",
  "JetBrainsMono Nerd Font Mono",
  "Fira Code",
  "Fira Code Retina",
  "FiraCode Nerd Font",
  "FiraCode Nerd Font Mono",
  "Fira Mono",
  "FiraMono Nerd Font",
  "Hack Nerd Font",
  "Hack Nerd Font Mono",
  "Source Code Pro",
  "SauceCodePro Nerd Font",
  "IBM Plex Mono",
  "BlexMono Nerd Font",
  "Roboto Mono",
  "RobotoMono Nerd Font",
  "Space Mono",
  "Anonymous Pro",
  "AnonymicePro Nerd Font",
  "Victor Mono",
  "VictorMono Nerd Font",
  "Iosevka",
  "Iosevka Term",
  "Iosevka Nerd Font",
  "Iosevka Term Nerd Font",
  "MesloLGS NF",
  "MesloLGS Nerd Font",
  "Meslo LG S",
  "Meslo LG M",
  "Meslo LG L",
  "MesloLGM Nerd Font",
  "Operator Mono",
  "Operator Mono Lig",
  "Comic Mono",
  "Comic Code",
  "Monaspace Neon",
  "Monaspace Argon",
  "Monaspace Xenon",
  "Monaspace Radon",
  "Monaspace Krypton",
  "Geist Mono",
  "GeistMono Nerd Font",
  "Maple Mono",
  "Maple Mono NF",
  "0xProto",
  "0xProto Nerd Font",
  "Departure Mono",
  "Berkeley Mono",
  "MonoLisa",
  "Dank Mono",
  "Cartograph CF",
  "PragmataPro",
  "PragmataPro Mono",
  "Input Mono",
  "Input",
  "Recursive Mono Linear Static",
  "Recursive Mono Casual Static",
  "Commit Mono",
  "Server Mono",
  "Martian Mono",
  "Spline Sans Mono",
  "Red Hat Mono",
  "Overpass Mono",
  "Azeret Mono",
  "Fragment Mono",
  "DM Mono",
  "Reddit Mono",
  "Nanum Gothic Coding",
  "D2Coding",
  "Sarasa Mono SC",
  "Sarasa Mono TC",
  "Sarasa Mono J",
  "Sarasa Mono K",
  "Terminus",
  "xterm",
  "ProFont",
  "ProFontWindows",
  "Gintronic",
  "Lekton",
  "Hasklig",
  "Hasklug Nerd Font",
  "mononoki",
  "mononoki Nerd Font",
  "Terminess Nerd Font",
  "BigBlueTerm Nerd Font",
  "Hurmit Nerd Font",
  "DaddyTimeMono Nerd Font",
  "ShureTechMono Nerd Font",
  "Monofur",
  "Monofur Nerd Font",
  "CodeNewRoman Nerd Font",
  "Agave",
  "Agave Nerd Font",
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
