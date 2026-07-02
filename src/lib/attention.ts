// Pure roll-up from per-pane attention flags to the tabs that own them.
// No React / no store — just a tree walk so the status bar and its unit test
// share one implementation.

import type { Workspace } from "./types";
import { collectLeafIds } from "./pane-tree";

/** A tab that has at least one pane awaiting operator action. */
export interface AttentionEntry {
  workspaceId: string;
  workspaceName: string;
  tabId: string;
  /** display label for the tab (customName wins over auto name) */
  tabName: string;
  tabIcon?: string;
  /** how many panes in this tab are waiting */
  count: number;
}

/**
 * Given the live workspaces and the set of pane ids flagged as waiting, return
 * one entry per tab that owns at least one waiting pane, in workspace→tab order.
 * File-viewer tabs are skipped (their inert leaf never rings a bell, but guard
 * anyway). The returned order is stable so the bar doesn't jump around.
 */
export function tabsNeedingAttention(
  workspaces: Workspace[],
  waiting: Set<string>
): AttentionEntry[] {
  if (waiting.size === 0) return [];
  const out: AttentionEntry[] = [];
  for (const ws of workspaces) {
    for (const tab of ws.tabs) {
      if (tab.file) continue;
      let count = 0;
      for (const id of collectLeafIds(tab.root)) {
        if (waiting.has(id)) count++;
      }
      if (count > 0) {
        out.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          tabId: tab.id,
          tabName: tab.customName?.trim() || tab.name,
          tabIcon: tab.icon,
          count,
        });
      }
    }
  }
  return out;
}
