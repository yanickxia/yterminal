// system-fonts: detect which monospace fonts are actually installed on the
// machine, so the Settings font picker can offer real system fonts beyond the
// handful of built-in presets.
//
// Two strategies, in order of preference:
//   1. Native enumeration via the Tauri `list_fonts` command (font-kit reads the
//      OS font catalog). This gives the *complete* set of installed monospace
//      families, not just ones we thought to list.
//   2. Canvas text-measurement fallback (for non-Tauri/dev-server contexts or if
//      the native call fails): render a probe string in a generic family, then in
//      `"Candidate", generic`; a width change means the candidate is installed.
//      This can only test names from a fixed CANDIDATES catalog.
//
// Why not the Local Font Access API? `queryLocalFonts()` is Chromium-only; the
// macOS WKWebView and Linux WebKitGTK that Tauri uses don't expose it.

import { invoke } from "@tauri-apps/api/core";
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

/** Wrap a list of family names into FontOptions (sorted, monospace fallback). */
function toFontOptions(families: string[]): FontOption[] {
  const out = families.map((family) => ({
    id: family,
    name: family,
    stack: `"${family}", monospace`,
  }));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Probe the candidate list and return FontOptions for the installed ones.
 * The id is the family name itself; the stack falls back to `monospace`.
 * This is the canvas fallback used when native enumeration is unavailable.
 */
export function detectSystemFontsCanvas(): FontOption[] {
  const found: string[] = [];
  for (const family of CANDIDATES) {
    if (isInstalled(family)) found.push(family);
  }
  return toFontOptions(found);
}

/**
 * Return every installed monospace font. Prefers native enumeration via the
 * Tauri `list_fonts` command (complete catalog); falls back to canvas
 * candidate-probing when that's unavailable (e.g. plain browser dev server) or
 * yields nothing.
 */
export async function detectSystemFonts(): Promise<FontOption[]> {
  try {
    const families = await invoke<string[]>("list_fonts");
    if (Array.isArray(families) && families.length > 0) {
      return toFontOptions(families);
    }
  } catch {
    /* not running under Tauri, or the command failed — use the fallback */
  }
  return detectSystemFontsCanvas();
}
