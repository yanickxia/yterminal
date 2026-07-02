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
  MIN_SCROLLBACK_LINES,
  MAX_SCROLLBACK_LINES,
  DEFAULT_SCROLLBACK_LINES,
  SCROLLBACK_UNLIMITED,
  DEFAULT_CWD_MODE,
  DEFAULT_REQUIRE_MODIFIER_FOR_LINKS,
  DEFAULT_COPY_ON_SELECT,
  DEFAULT_AUTO_TAB_TITLE,
  type DefaultCwdMode,
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
    /** xterm scrollback lines; 0 = unlimited */
    scrollbackLines: number;
  };
  /** Terminal behavior — currently just the default-cwd policy. */
  terminal: {
    defaultCwd: {
      /** "home" | "inherit" | "fixed" */
      mode: DefaultCwdMode;
      /** absolute path used when mode === "fixed" */
      fixedPath: string;
    };
    /** require Cmd/Ctrl to open links from terminal output (false = plain click) */
    requireModifierForLinks: boolean;
    /** auto-copy the terminal selection to the clipboard when it changes */
    copyOnSelect: boolean;
    /** let the shell/agent terminal title drive an un-renamed tab's name */
    autoTabTitle: boolean;
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
      scrollbackLines: s.scrollbackLines,
    },
    terminal: {
      defaultCwd: {
        mode: s.defaultCwdMode,
        fixedPath: s.defaultCwdFixed,
      },
      requireModifierForLinks: s.requireModifierForLinks,
      copyOnSelect: s.copyOnSelect,
      autoTabTitle: s.autoTabTitle,
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

function clampScrollback(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return DEFAULT_SCROLLBACK_LINES;
  }
  if (n === SCROLLBACK_UNLIMITED) return SCROLLBACK_UNLIMITED;
  return Math.max(
    MIN_SCROLLBACK_LINES,
    Math.min(MAX_SCROLLBACK_LINES, Math.round(n))
  );
}

function validCwdMode(m: unknown): DefaultCwdMode {
  return m === "home" || m === "inherit" || m === "fixed" ? m : DEFAULT_CWD_MODE;
}

function validFixedPath(p: unknown): string {
  return typeof p === "string" ? p : "";
}

function validBool(b: unknown, fallback: boolean): boolean {
  return typeof b === "boolean" ? b : fallback;
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
  const tm = raw.terminal ?? {};
  const dc = tm.defaultCwd ?? {};

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
      scrollbackLines: clampScrollback(ap.scrollbackLines),
    },
    terminal: {
      defaultCwd: {
        mode: validCwdMode(dc.mode),
        fixedPath: validFixedPath(dc.fixedPath),
      },
      requireModifierForLinks: validBool(
        tm.requireModifierForLinks,
        DEFAULT_REQUIRE_MODIFIER_FOR_LINKS
      ),
      copyOnSelect: validBool(tm.copyOnSelect, DEFAULT_COPY_ON_SELECT),
      autoTabTitle: validBool(tm.autoTabTitle, DEFAULT_AUTO_TAB_TITLE),
    },
  };
}

/** Push a parsed config into the settings store (only if values differ). */
export function applyConfigToStore(cfg: YterminalConfig) {
  const s = useSettingsStore.getState();
  const {
    theme,
    font,
    fontSize,
    dividerWidth,
    dividerColor,
    scrollbackLines,
  } = cfg.appearance;
  if (theme !== s.themeId) s.setTheme(theme);
  if (font !== s.fontId) s.setFont(font);
  if (fontSize !== s.fontSize) s.setFontSize(fontSize);
  if (dividerWidth !== s.dividerWidth) s.setDividerWidth(dividerWidth);
  if (dividerColor !== s.dividerColor) s.setDividerColor(dividerColor);
  if (scrollbackLines !== s.scrollbackLines) s.setScrollbackLines(scrollbackLines);
  const { mode, fixedPath } = cfg.terminal.defaultCwd;
  if (mode !== s.defaultCwdMode) s.setDefaultCwdMode(mode);
  if (fixedPath !== s.defaultCwdFixed) s.setDefaultCwdFixed(fixedPath);
  const { requireModifierForLinks } = cfg.terminal;
  if (requireModifierForLinks !== s.requireModifierForLinks)
    s.setRequireModifierForLinks(requireModifierForLinks);
  const { copyOnSelect } = cfg.terminal;
  if (copyOnSelect !== s.copyOnSelect) s.setCopyOnSelect(copyOnSelect);
  const { autoTabTitle } = cfg.terminal;
  if (autoTabTitle !== s.autoTabTitle) s.setAutoTabTitle(autoTabTitle);
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
