// themes: built-in color schemes for the terminal + app chrome.
//
// Each theme drives two things:
//   1. the xterm.js ITheme (terminal cell colors)
//   2. the app-chrome CSS variables (sidebar / tabbar / dividers) so the whole
//      window matches, not just the terminal area.

export interface ThemePalette {
  // app chrome (maps onto the CSS vars in styles.css)
  bgDark: string;
  bgMedium: string;
  bgLight: string;
  fg: string;
  fgDim: string;
  accent: string;
  // terminal ANSI colors
  cursor: string;
  selection: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
}

export interface Theme {
  id: string;
  name: string;
  palette: ThemePalette;
}

export const THEMES: Theme[] = [
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    palette: {
      bgDark: "#1a1b26",
      bgMedium: "#24283b",
      bgLight: "#414868",
      fg: "#c0caf5",
      fgDim: "#565f89",
      accent: "#7aa2f7",
      cursor: "#7aa2f7",
      selection: "#33467c",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    palette: {
      bgDark: "#282a36",
      bgMedium: "#343746",
      bgLight: "#44475a",
      fg: "#f8f8f2",
      fgDim: "#6272a4",
      accent: "#bd93f9",
      cursor: "#f8f8f2",
      selection: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    palette: {
      bgDark: "#002b36",
      bgMedium: "#073642",
      bgLight: "#0a4d5e",
      fg: "#93a1a1",
      fgDim: "#586e75",
      accent: "#268bd2",
      cursor: "#93a1a1",
      selection: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    palette: {
      bgDark: "#1d2021",
      bgMedium: "#282828",
      bgLight: "#3c3836",
      fg: "#ebdbb2",
      fgDim: "#928374",
      accent: "#fabd2f",
      cursor: "#ebdbb2",
      selection: "#504945",
      black: "#282828",
      red: "#fb4934",
      green: "#b8bb26",
      yellow: "#fabd2f",
      blue: "#83a598",
      magenta: "#d3869b",
      cyan: "#8ec07c",
      white: "#ebdbb2",
    },
  },
  {
    id: "one-light",
    name: "One Light",
    palette: {
      bgDark: "#fafafa",
      bgMedium: "#eaeaeb",
      bgLight: "#d4d4d5",
      fg: "#383a42",
      fgDim: "#a0a1a7",
      accent: "#4078f2",
      cursor: "#383a42",
      selection: "#cceeff",
      black: "#383a42",
      red: "#e45649",
      green: "#50a14f",
      yellow: "#c18401",
      blue: "#4078f2",
      magenta: "#a626a4",
      cyan: "#0184bc",
      white: "#fafafa",
    },
  },
];

export const DEFAULT_THEME_ID = "tokyo-night";

export function getTheme(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Convert a theme palette into an xterm.js ITheme. */
export function toXtermTheme(p: ThemePalette) {
  return {
    background: p.bgDark,
    foreground: p.fg,
    cursor: p.cursor,
    selectionBackground: p.selection,
    black: p.black,
    red: p.red,
    green: p.green,
    yellow: p.yellow,
    blue: p.blue,
    magenta: p.magenta,
    cyan: p.cyan,
    white: p.white,
  };
}

// ---- font presets ----
export interface FontOption {
  id: string;
  name: string;
  stack: string;
}

export const FONTS: FontOption[] = [
  {
    id: "jetbrains-mono",
    name: "JetBrains Mono",
    stack: 'JetBrainsMono, Menlo, Monaco, "Courier New", monospace',
  },
  {
    id: "menlo",
    name: "Menlo / Monaco",
    stack: 'Menlo, Monaco, "Courier New", monospace',
  },
  {
    id: "cascadia",
    name: "Cascadia Code",
    stack: '"Cascadia Code", Menlo, Consolas, monospace',
  },
  {
    id: "fira-code",
    name: "Fira Code",
    stack: '"Fira Code", Menlo, Consolas, monospace',
  },
  {
    id: "sf-mono",
    name: "SF Mono",
    stack: '"SF Mono", Menlo, Monaco, monospace',
  },
];

export const DEFAULT_FONT_ID = "jetbrains-mono";

// System fonts detected at runtime (see system-fonts.ts). Kept separate from the
// curated built-in presets above, but merged for lookup via getAllFonts().
let systemFonts: FontOption[] = [];

/** Register the monospace fonts detected on this machine (dedup vs presets). */
export function registerSystemFonts(list: FontOption[]) {
  const builtinIds = new Set(FONTS.map((f) => f.id));
  systemFonts = list.filter((f) => !builtinIds.has(f.id));
}

/** Built-in presets plus any detected system fonts. */
export function getAllFonts(): FontOption[] {
  return [...FONTS, ...systemFonts];
}

export function getFont(id: string): FontOption {
  const hit = getAllFonts().find((f) => f.id === id);
  if (hit) return hit;
  // A saved/hand-edited id may name an installed font we haven't catalogued
  // (or detection hasn't run yet). Synthesize a stack with a monospace
  // fallback so it still renders sensibly instead of snapping back to default.
  if (id && id.trim()) {
    return { id, name: id, stack: `"${id}", monospace` };
  }
  return FONTS[0];
}

