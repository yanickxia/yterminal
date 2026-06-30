// viewer-store: drives the read-only built-in file viewer modal. Not
// persisted — it's transient UI state. A single viewer is open at a time;
// opening another file replaces the current one.

import { create } from "zustand";
import { readTextFile } from "../lib/file-reader";

interface ViewerState {
  open: boolean;
  path: string | null;
  /** highlight.js language id; "markdown" is rendered rather than highlighted */
  language: string;
  markdown: boolean;
  /** raw file text once loaded */
  text: string;
  /** true while the backend read is in flight */
  loading: boolean;
  /** populated when the read fails (missing / too large / binary) */
  error: string | null;

  openFile: (args: {
    path: string;
    language: string;
    markdown: boolean;
  }) => Promise<void>;
  close: () => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
  open: false,
  path: null,
  language: "plaintext",
  markdown: false,
  text: "",
  loading: false,
  error: null,

  openFile: async ({ path, language, markdown }) => {
    set({
      open: true,
      path,
      language,
      markdown,
      text: "",
      loading: true,
      error: null,
    });
    try {
      const { text } = await readTextFile(path);
      // ignore a stale read if the user already closed/replaced the viewer.
      set((s) =>
        s.path === path ? { text, loading: false } : s
      );
    } catch (e) {
      set((s) =>
        s.path === path
          ? { loading: false, error: String(e) }
          : s
      );
    }
  },

  close: () =>
    set({
      open: false,
      path: null,
      text: "",
      error: null,
      loading: false,
    }),
}));
