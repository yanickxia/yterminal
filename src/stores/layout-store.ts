// layout-store: persisted chrome geometry — the widths of the side panels
// (workspace sidebar, AI sidebar, git sidebar) and whether the workspace
// sidebar is collapsed. Kept in one small store so App (which renders the draggable
// dividers and refits terminals) and the panels themselves (which apply the
// width to their root and own the collapse toggle) share a single source of
// truth. Persisted to localStorage so the layout survives reloads.

import { create } from "zustand";

const SIDEBAR_W_KEY = "yterminal.layout.sidebarWidth";
const AI_W_KEY = "yterminal.layout.aiWidth";
const GIT_W_KEY = "yterminal.layout.gitWidth";
// Reuse the pre-existing collapse key so users' saved state migrates silently.
const COLLAPSE_KEY = "yterminal.sidebar.collapsed";

// Drag bounds (px). Min keeps a panel usable; max keeps the terminal usable.
export const SIDEBAR_MIN = 140;
export const SIDEBAR_MAX = 520;
export const AI_MIN = 260;
export const AI_MAX = 760;
export const GIT_MIN = 220;
export const GIT_MAX = 620;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function loadNum(key: string, def: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return def;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? clamp(n, min, max) : def;
  } catch {
    return def;
  }
}

function save(key: string, val: string): void {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* storage unavailable */
  }
}

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

interface LayoutState {
  /** Workspace sidebar width in px (ignored while collapsed). */
  sidebarWidth: number;
  /** AI sidebar width in px. */
  aiWidth: number;
  /** Git sidebar width in px. */
  gitWidth: number;
  /** Whether the workspace sidebar is collapsed to the icon rail. */
  sidebarCollapsed: boolean;
  setSidebarWidth: (w: number) => void;
  setAiWidth: (w: number) => void;
  setGitWidth: (w: number) => void;
  setSidebarCollapsed: (c: boolean) => void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  sidebarWidth: loadNum(SIDEBAR_W_KEY, 200, SIDEBAR_MIN, SIDEBAR_MAX),
  aiWidth: loadNum(AI_W_KEY, 340, AI_MIN, AI_MAX),
  gitWidth: loadNum(GIT_W_KEY, 300, GIT_MIN, GIT_MAX),
  sidebarCollapsed: loadCollapsed(),
  setSidebarWidth: (w) => {
    const clamped = clamp(w, SIDEBAR_MIN, SIDEBAR_MAX);
    save(SIDEBAR_W_KEY, String(Math.round(clamped)));
    set({ sidebarWidth: clamped });
  },
  setAiWidth: (w) => {
    const clamped = clamp(w, AI_MIN, AI_MAX);
    save(AI_W_KEY, String(Math.round(clamped)));
    set({ aiWidth: clamped });
  },
  setGitWidth: (w) => {
    const clamped = clamp(w, GIT_MIN, GIT_MAX);
    save(GIT_W_KEY, String(Math.round(clamped)));
    set({ gitWidth: clamped });
  },
  setSidebarCollapsed: (c) => {
    save(COLLAPSE_KEY, c ? "1" : "0");
    set({ sidebarCollapsed: c });
  },
}));
