// config: a plain JSON file on disk that mirrors the user's appearance
// settings, so it can be synced across machines (git, Dropbox, etc.) and edited
// by hand. The file lives at:
//   macOS / Linux: ~/.config/yterminal/config.json  (honors $XDG_CONFIG_HOME)
//   Windows:       %APPDATA%\yterminal\config.json
//
// The Rust backend owns the actual file IO (read_config / write_config /
// config_file_path commands). This module maps between that raw JSON and the
// Zustand settings store, validating every field against the known theme/font
// catalogs so a hand-edited file can never put the app into a broken state.

import { invoke } from "@tauri-apps/api/core";
import { THEMES, getAllFonts, DEFAULT_THEME_ID, DEFAULT_FONT_ID } from "./themes";
import {
  useSettingsStore,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_DIVIDER_WIDTH,
  MAX_DIVIDER_WIDTH,
  DEFAULT_DIVIDER_WIDTH,
  DEFAULT_DIVIDER_COLOR,
} from "../stores/settings-store";

/** The on-disk schema. Kept intentionally small and stable. */
export interface YterminalConfig {
  /** schema version, for forward-compatible migrations */
  version: number;
  appearance: {
    /** theme id, e.g. "tokyo-night" (see themes.ts) */
    theme: string;
    /** font id, e.g. "jetbrains-mono" (see themes.ts) */
    font: string;
    /** font size in px, clamped to [MIN_FONT_SIZE, MAX_FONT_SIZE] */
    fontSize: number;
    /** pane divider line width in px (0 hides it) */
    dividerWidth: number;
    /** pane divider line color (any CSS color string) */
    dividerColor: string;
  };
}

export const CONFIG_VERSION = 1;

/** Build a config object from the current in-memory settings. */
export function configFromStore(): YterminalConfig {
  const s = useSettingsStore.getState();
  return {
    version: CONFIG_VERSION,
    appearance: {
      theme: s.themeId,
      font: s.fontId,
      fontSize: s.fontSize,
      dividerWidth: s.dividerWidth,
      dividerColor: s.dividerColor,
    },
  };
}

function clampFontSize(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 14;
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(v)));
}

function clampDividerWidth(n: unknown): number {
  const v =
    typeof n === "number" && Number.isFinite(n) ? n : DEFAULT_DIVIDER_WIDTH;
  return Math.max(
    MIN_DIVIDER_WIDTH,
    Math.min(MAX_DIVIDER_WIDTH, Math.round(v))
  );
}

function validDividerColor(c: unknown): string {
  return typeof c === "string" && c.trim().length > 0
    ? c
    : DEFAULT_DIVIDER_COLOR;
}

/**
 * Parse + validate raw JSON text into a normalized config. Unknown/invalid
 * values fall back to defaults, so a malformed or partial file is always safe.
 * Returns null if the text isn't valid JSON at all.
 */
export function parseConfig(text: string): YterminalConfig | null {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const ap = raw.appearance ?? {};

  const themeOk = THEMES.some((t) => t.id === ap.theme);
  // accept any built-in preset OR a detected system font; an unknown id is kept
  // only if it's a non-empty string (a hand-edited font name we may not have
  // probed yet), otherwise it falls back to the default.
  const knownFont = getAllFonts().some((f) => f.id === ap.font);
  const fontOk =
    knownFont || (typeof ap.font === "string" && ap.font.trim().length > 0);

  return {
    version: typeof raw.version === "number" ? raw.version : CONFIG_VERSION,
    appearance: {
      theme: themeOk ? ap.theme : DEFAULT_THEME_ID,
      font: fontOk ? ap.font : DEFAULT_FONT_ID,
      fontSize: clampFontSize(ap.fontSize),
      dividerWidth: clampDividerWidth(ap.dividerWidth),
      dividerColor: validDividerColor(ap.dividerColor),
    },
  };
}

/** Push a parsed config into the settings store (only if values differ). */
export function applyConfigToStore(cfg: YterminalConfig) {
  const s = useSettingsStore.getState();
  const { theme, font, fontSize, dividerWidth, dividerColor } = cfg.appearance;
  if (theme !== s.themeId) s.setTheme(theme);
  if (font !== s.fontId) s.setFont(font);
  if (fontSize !== s.fontSize) s.setFontSize(fontSize);
  if (dividerWidth !== s.dividerWidth) s.setDividerWidth(dividerWidth);
  if (dividerColor !== s.dividerColor) s.setDividerColor(dividerColor);
}

/** Absolute path of the config file (for display in the UI). */
export async function configFilePath(): Promise<string> {
  try {
    return await invoke<string>("config_file_path");
  } catch {
    return "";
  }
}

/**
 * Load config from disk and apply it to the store. If the file is missing or
 * empty, seed it from the current store so the user has something to edit.
 * Returns true if a valid file was loaded and applied.
 */
export async function loadConfigFromDisk(): Promise<boolean> {
  let text = "";
  try {
    text = await invoke<string>("read_config");
  } catch {
    return false;
  }
  if (!text.trim()) {
    // first run: write out the current defaults so the file exists to sync
    await saveConfigToDisk();
    return false;
  }
  const cfg = parseConfig(text);
  if (!cfg) return false;
  applyConfigToStore(cfg);
  return true;
}

/** Serialize the current store to the JSON file on disk. */
export async function saveConfigToDisk(): Promise<void> {
  const json = JSON.stringify(configFromStore(), null, 2) + "\n";
  try {
    await invoke("write_config", { contents: json });
  } catch {
    /* non-fatal: persistence to localStorage still works */
  }
}
