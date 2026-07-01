// settings-store: user-facing appearance config (theme, font, font size).
// Persisted separately from workspaces so it survives independently.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_THEME_ID, DEFAULT_FONT_ID } from "../lib/themes";

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 28;

export const MIN_DIVIDER_WIDTH = 0;
export const MAX_DIVIDER_WIDTH = 10;
export const DEFAULT_DIVIDER_WIDTH = 1;
export const DEFAULT_DIVIDER_COLOR = "#3a3f4b";

/** Hard floor for the per-terminal in-memory scrollback. */
export const MIN_SCROLLBACK_LINES = 100;
/** Hard ceiling for "fixed" mode; users pick "unlimited" beyond this. */
export const MAX_SCROLLBACK_LINES = 1_000_000;
export const DEFAULT_SCROLLBACK_LINES = 10_000;
/** Sentinel persisted when the user picks "unlimited". */
export const SCROLLBACK_UNLIMITED = 0;

/**
 * Fallback policy for shells that cannot inherit a live pane cwd. Normal new
 * tabs inherit the active pane in their own workspace; restore-on-launch uses
 * the saved pane cwd.
 *
 *   home    — always $HOME (the shell's default if you pass no cwd)
 *   inherit — carry forward when a scoped cwd is available, else $HOME
 *   fixed   — always `defaultCwdFixed` (e.g. a project root you live in)
 */
export type DefaultCwdMode = "home" | "inherit" | "fixed";
export const DEFAULT_CWD_MODE: DefaultCwdMode = "inherit";

/**
 * Whether opening links (web URLs and file paths) from terminal output
 * requires the platform modifier key (Cmd on macOS, Ctrl elsewhere). When
 * false, a plain click opens them — the terminal sniffs links directly with
 * no helper key. Default true to match conventional terminal behavior.
 */
export const DEFAULT_REQUIRE_MODIFIER_FOR_LINKS = true;

/**
 * A configured AI provider for the sidebar. `baseUrl` is an OpenAI-compatible
 * API root (e.g. "https://api.openai.com/v1"); the Rust `ai_chat` command
 * appends "/chat/completions". `apiKey` lives in localStorage only — it is
 * deliberately NOT mirrored to the syncable ~/.config JSON so it can't leak via
 * git/Dropbox.
 */
export interface AiProvider {
  id: string;
  /** display label, e.g. "OpenAI" */
  name: string;
  /** API root, e.g. "https://api.openai.com/v1" */
  baseUrl: string;
  /** model id, e.g. "gpt-4o-mini" */
  model: string;
  /** bearer token; localStorage-only, never written to the JSON config */
  apiKey: string;
}

/** Stable id for a fresh provider row. crypto.randomUUID when available. */
function newProviderId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

interface SettingsState {
  themeId: string;
  fontId: string;
  fontSize: number;
  dividerWidth: number;
  dividerColor: string;
  /** xterm.js scrollback buffer cap. 0 means unlimited. */
  scrollbackLines: number;
  defaultCwdMode: DefaultCwdMode;
  /** absolute path used when defaultCwdMode === "fixed"; empty falls back to home */
  defaultCwdFixed: string;
  /**
   * Require the platform modifier (Cmd/Ctrl) to open links from the terminal.
   * When false, a plain click opens web URLs and file paths.
   */
  requireModifierForLinks: boolean;
  /** capture verbose (DEBUG/TRACE) debug logs; default on until opted out */
  debugVerbose: boolean;
  /** configured AI providers for the sidebar (see AiProvider) */
  aiProviders: AiProvider[];
  /** id of the provider used for new AI requests; "" when none configured */
  activeAiProviderId: string;

  setTheme: (id: string) => void;
  setFont: (id: string) => void;
  setFontSize: (px: number) => void;
  setDividerWidth: (px: number) => void;
  setDividerColor: (color: string) => void;
  setScrollbackLines: (lines: number) => void;
  setDefaultCwdMode: (mode: DefaultCwdMode) => void;
  setDefaultCwdFixed: (path: string) => void;
  setRequireModifierForLinks: (on: boolean) => void;
  setDebugVerbose: (on: boolean) => void;
  /** append a blank provider row and make it active; returns its id */
  addAiProvider: () => string;
  /** merge partial fields into an existing provider by id */
  updateAiProvider: (id: string, patch: Partial<Omit<AiProvider, "id">>) => void;
  /** remove a provider; if it was active, active falls back to the first left */
  removeAiProvider: (id: string) => void;
  setActiveAiProvider: (id: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      themeId: DEFAULT_THEME_ID,
      fontId: DEFAULT_FONT_ID,
      fontSize: 14,
      dividerWidth: DEFAULT_DIVIDER_WIDTH,
      dividerColor: DEFAULT_DIVIDER_COLOR,
      scrollbackLines: DEFAULT_SCROLLBACK_LINES,
      defaultCwdMode: DEFAULT_CWD_MODE,
      defaultCwdFixed: "",
      requireModifierForLinks: DEFAULT_REQUIRE_MODIFIER_FOR_LINKS,
      debugVerbose: true,
      aiProviders: [],
      activeAiProviderId: "",

      setTheme: (id) => set({ themeId: id }),
      setFont: (id) => set({ fontId: id }),
      setFontSize: (px) =>
        set({
          fontSize: Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, px)),
        }),
      setDividerWidth: (px) =>
        set({
          dividerWidth: Math.max(
            MIN_DIVIDER_WIDTH,
            Math.min(MAX_DIVIDER_WIDTH, Math.round(px))
          ),
        }),
      setDividerColor: (color) => set({ dividerColor: color }),
      setScrollbackLines: (lines) =>
        set({
          scrollbackLines:
            lines === SCROLLBACK_UNLIMITED
              ? SCROLLBACK_UNLIMITED
              : Math.max(
                  MIN_SCROLLBACK_LINES,
                  Math.min(MAX_SCROLLBACK_LINES, Math.round(lines))
                ),
        }),
      setDefaultCwdMode: (mode) => set({ defaultCwdMode: mode }),
      setDefaultCwdFixed: (path) => set({ defaultCwdFixed: path }),
      setRequireModifierForLinks: (on) =>
        set({ requireModifierForLinks: on }),
      setDebugVerbose: (on) => set({ debugVerbose: on }),
      addAiProvider: () => {
        const id = newProviderId();
        set((s) => ({
          aiProviders: [
            ...s.aiProviders,
            {
              id,
              name: "New provider",
              baseUrl: "https://api.openai.com/v1",
              model: "gpt-4o-mini",
              apiKey: "",
            },
          ],
          // first provider added becomes active automatically
          activeAiProviderId: s.activeAiProviderId || id,
        }));
        return id;
      },
      updateAiProvider: (id, patch) =>
        set((s) => ({
          aiProviders: s.aiProviders.map((p) =>
            p.id === id ? { ...p, ...patch } : p
          ),
        })),
      removeAiProvider: (id) =>
        set((s) => {
          const aiProviders = s.aiProviders.filter((p) => p.id !== id);
          const activeAiProviderId =
            s.activeAiProviderId === id
              ? aiProviders[0]?.id ?? ""
              : s.activeAiProviderId;
          return { aiProviders, activeAiProviderId };
        }),
      setActiveAiProvider: (id) => set({ activeAiProviderId: id }),
    }),
    { name: "yterminal-settings", version: 4 }
  )
);

/** The active AI provider, or undefined when none is configured/selected. */
export function activeAiProvider(): AiProvider | undefined {
  const s = useSettingsStore.getState();
  return (
    s.aiProviders.find((p) => p.id === s.activeAiProviderId) ??
    s.aiProviders[0]
  );
}

/** Resolve the persisted scrollback setting to a concrete number for xterm. */
export function resolveScrollback(lines: number): number {
  return lines === SCROLLBACK_UNLIMITED ? Number.MAX_SAFE_INTEGER : lines;
}
