// viewer-store: holds the transient (non-persisted) content of file-viewer
// tabs, keyed by tab id. The durable part of a file tab — its path/language/
// markdown descriptor — lives on the Tab in the workspace store and survives
// relaunch; the file *text* does not (it can be large), so it's re-read from
// disk here whenever a file tab first renders.

import { create } from "zustand";
import { readTextFile } from "../lib/file-reader";

interface FileState {
  /** raw file text once loaded */
  text: string;
  /** true while the backend read is in flight */
  loading: boolean;
  /** populated when the read fails (missing / too large / binary) */
  error: string | null;
}

interface ViewerState {
  /** loaded content per file-tab id */
  files: Record<string, FileState>;
  /** transient vertical reading position per file-tab id */
  scrollTops: Record<string, number>;

  /**
   * Ensure the file at `path` is loaded for tab `tabId`. Idempotent: a tab that
   * already has content (or is mid-load) is left alone, so re-activating a file
   * tab doesn't re-read the disk.
   */
  load: (tabId: string, path: string, workspaceId?: string) => Promise<void>;
  /** Remember a file tab's vertical reading position. */
  setScrollTop: (tabId: string, scrollTop: number) => void;
  /** Forget a tab's content (call when the file tab is closed). */
  drop: (tabId: string) => void;
}

export const useViewerStore = create<ViewerState>((set, get) => ({
  files: {},
  scrollTops: {},

  load: async (tabId, path, workspaceId) => {
    const existing = get().files[tabId];
    if (existing) return; // already loaded or loading
    set((s) => ({
      files: { ...s.files, [tabId]: { text: "", loading: true, error: null } },
    }));
    try {
      const { text } = await readTextFile(path, workspaceId);
      set((s) =>
        s.files[tabId]
          ? { files: { ...s.files, [tabId]: { text, loading: false, error: null } } }
          : s
      );
    } catch (e) {
      set((s) =>
        s.files[tabId]
          ? {
              files: {
                ...s.files,
                [tabId]: { text: "", loading: false, error: String(e) },
              },
            }
          : s
      );
    }
  },

  setScrollTop: (tabId, scrollTop) =>
    set((s) => {
      const next = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
      if (s.scrollTops[tabId] === next) return s;
      return { scrollTops: { ...s.scrollTops, [tabId]: next } };
    }),

  drop: (tabId) =>
    set((s) => {
      if (!s.files[tabId] && s.scrollTops[tabId] === undefined) return s;
      const files = { ...s.files };
      const scrollTops = { ...s.scrollTops };
      delete files[tabId];
      delete scrollTops[tabId];
      return { files, scrollTops };
    }),
}));
