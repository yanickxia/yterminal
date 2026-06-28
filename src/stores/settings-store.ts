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

interface SettingsState {
  themeId: string;
  fontId: string;
  fontSize: number;
  dividerWidth: number;
  dividerColor: string;

  setTheme: (id: string) => void;
  setFont: (id: string) => void;
  setFontSize: (px: number) => void;
  setDividerWidth: (px: number) => void;
  setDividerColor: (color: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      themeId: DEFAULT_THEME_ID,
      fontId: DEFAULT_FONT_ID,
      fontSize: 14,
      dividerWidth: DEFAULT_DIVIDER_WIDTH,
      dividerColor: DEFAULT_DIVIDER_COLOR,

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
    }),
    { name: "yterminal-settings", version: 2 }
  )
);
