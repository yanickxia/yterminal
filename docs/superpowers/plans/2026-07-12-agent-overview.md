# Agent 透视图（Agent Overview）Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个全局透视图浮层，跨所有 workspace 以卡片网格展示所有含 coding agent 的 pane（含空闲），每卡内嵌终端尾部静态文本快照预览，点击/回车跳转到该 agent 并关闭浮层。

**Architecture:** 纯 TS，无 Rust、无持久化。一个纯函数聚合器 `agent-overview.ts` 跨所有 workspace 收集 agent（复用 `workspace-agents.ts` 的 `classify`），一个 React 浮层组件 `AgentOverview.tsx`（照搬 `WorkspacePalette` 的 `.modal-backdrop` 范式 + 固定列数网格键盘导航），在三个入口接线：快捷键 `Cmd+O`/`Ctrl+Shift+O`、状态栏按钮、命令面板顶部动作行。

**Tech Stack:** TypeScript (strict), React 18, Zustand, Vitest, xterm SerializeAddon（经 `getSessionText`）。

规格文档：`docs/superpowers/specs/2026-07-12-agent-overview-design.md`

---

## 文件结构

- **Create** `src/lib/agent-overview.ts` — 纯函数 `collectAllAgents(...)` + `AgentOverviewEntry` 类型 + `OVERVIEW_COLS` 常量。单一职责：跨 workspace 聚合 + 排序。
- **Create** `src/lib/agent-overview.test.ts` — `collectAllAgents` 的单测。
- **Create** `src/components/AgentOverview.tsx` — 卡片网格浮层 UI。
- **Modify** `src/lib/workspace-agents.ts:79` — 把私有 `function classify` 改为 `export function classify`。
- **Modify** `src/lib/app-shortcut.ts:26-36,65-76` — `AppShortcut` 加 `"overview"`，`case "o"` 绑定。
- **Modify** `src/App.tsx` — `overviewOpen` state、`case "overview"` 快捷键、挂载 `<AgentOverview>`、给 `<WorkspaceStatusBar>` 传 `onOpenOverview`。
- **Modify** `src/components/WorkspaceStatusBar.tsx` — 加 `onOpenOverview` prop + 一个透视图按钮。
- **Modify** `src/components/WorkspacePalette.tsx` — 顶部固定动作行"打开 Agent 透视图"（加 `onOpenOverview` prop）。
- **Modify** `src/styles.css` — `.agent-overview*` 样式。
- **Modify** `CLAUDE.md` — 架构章节新增"Agent 透视图"小节。

---

## Chunk 1: 纯函数聚合器 + classify 导出

### Task 1: 导出 classify

**Files:**
- Modify: `src/lib/workspace-agents.ts:79`

- [ ] **Step 1: 改为导出**

把 `src/lib/workspace-agents.ts` 第 79 行的：

```ts
function classify(
```

改为：

```ts
export function classify(
```

（函数体不变。`workspace-agents.test.ts` 已有覆盖，此改动不影响其行为。）

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过，无错误。

- [ ] **Step 3: Commit**

```bash
git add src/lib/workspace-agents.ts
git commit -m "refactor: export classify from workspace-agents for reuse"
```

---

### Task 2: agent-overview.ts 纯函数（TDD）

**Files:**
- Create: `src/lib/agent-overview.ts`
- Test: `src/lib/agent-overview.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/agent-overview.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { collectAllAgents, OVERVIEW_COLS } from "./agent-overview";
import type { Workspace, PaneLeaf, PaneTree } from "./types";

// 造一个带 agent 的 leaf
function leaf(id: string, agentKind?: "claude" | "codex" | "opencode"): PaneLeaf {
  return {
    type: "leaf",
    id,
    cwd: "/tmp",
    ...(agentKind
      ? { agent: { kind: agentKind, command: agentKind, sessionId: "s" } }
      : {}),
  } as PaneLeaf;
}

function ws(id: string, name: string, roots: PaneTree[]): Workspace {
  return {
    id,
    name,
    tabs: roots.map((root, i) => ({
      id: `${id}-t${i}`,
      name: `tab${i}`,
      cwd: "/tmp",
      root,
      activePaneId: (root as PaneLeaf).id,
    })),
    activeTabId: `${id}-t0`,
  } as Workspace;
}

const empty = new Set<string>();

describe("collectAllAgents", () => {
  it("空输入返回空数组", () => {
    expect(collectAllAgents([], empty, empty, empty)).toEqual([]);
  });

  it("跨多 workspace 聚合所有 agent（含空闲）", () => {
    const workspaces = [
      ws("w1", "Alpha", [leaf("p1", "claude"), leaf("p2", "codex")]),
      ws("w2", "Beta", [leaf("p3", "opencode")]),
    ];
    const out = collectAllAgents(workspaces, empty, empty, empty);
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.paneId).sort()).toEqual(["p1", "p2", "p3"]);
    // idle agent 也在内（无任何 active/waiting 信号）
    expect(out.every((e) => e.state === "idle")).toBe(true);
    // 带上 workspace 信息
    const p1 = out.find((e) => e.paneId === "p1")!;
    expect(p1.workspaceId).toBe("w1");
    expect(p1.workspaceName).toBe("Alpha");
  });

  it("跳过没有 agent 的 pane 和 file tab", () => {
    const workspaces = [ws("w1", "Alpha", [leaf("p1"), leaf("p2", "claude")])];
    const out = collectAllAgents(workspaces, empty, empty, empty);
    expect(out.map((e) => e.paneId)).toEqual(["p2"]);
  });

  it("按紧急度排序 attention > executing > waiting > idle", () => {
    const workspaces = [
      ws("w1", "Alpha", [
        leaf("idle1", "claude"),
        leaf("exec1", "claude"),
        leaf("attn1", "claude"),
        leaf("wait1", "claude"),
      ]),
    ];
    const waiting = new Set(["attn1"]); // bell -> attention
    const active = new Set(["exec1"]); // 正在输出 -> executing
    const everActive = new Set(["wait1"]); // 曾活跃、现静默 -> waiting
    const out = collectAllAgents(workspaces, waiting, active, everActive);
    expect(out.map((e) => e.paneId)).toEqual([
      "attn1",
      "exec1",
      "wait1",
      "idle1",
    ]);
  });

  it("导出固定网格列数常量", () => {
    expect(OVERVIEW_COLS).toBe(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/lib/agent-overview.test.ts`
Expected: FAIL，报 `collectAllAgents`/`OVERVIEW_COLS` 未定义（模块不存在）。

- [ ] **Step 3: 写最小实现**

创建 `src/lib/agent-overview.ts`：

```ts
// 跨所有 workspace 的全局 agent 聚合，供 Agent 透视图浮层使用。纯函数、无 IO、
// 无 React —— 与 workspace-agents.ts 共享同一套 classify 判定，只是把范围从
// 单个 workspace 扩到全部，并按紧急度排序（需要关注的排最前）。

import type { Workspace } from "./types";
import type { AgentHookState } from "./agent-hook-osc";
import type { WorkspaceAgentEntry, AgentRunState } from "./workspace-agents";
import { classify } from "./workspace-agents";
import { collectLeaves } from "./pane-tree";

/** 透视图卡片网格的固定列数。用固定值让键盘方向键的行/列换算确定、可测。 */
export const OVERVIEW_COLS = 3;

/** 一个 agent 条目，在 WorkspaceAgentEntry 基础上带上归属 workspace 信息。 */
export interface AgentOverviewEntry extends WorkspaceAgentEntry {
  workspaceId: string;
  workspaceName: string;
  workspaceIcon?: string;
}

// 紧急度排序权重（数值大 = 更靠前）。
const RANK: Record<AgentRunState, number> = {
  attention: 3,
  executing: 2,
  waiting: 1,
  idle: 0,
};

/**
 * 跨所有 workspace 收集每一个运行着 coding agent 的 pane（含空闲）。file tab
 * 跳过。用共享的 classify 判定 state，然后按 attention > executing > waiting >
 * idle 分组降序排序；同组内保持 workspace→tab→pane 的稳定遍历顺序。
 */
export function collectAllAgents(
  workspaces: Workspace[],
  waiting: Set<string>,
  active: Set<string>,
  everActive: Set<string>,
  focusedPaneId?: string,
  hookState?: Map<string, AgentHookState>
): AgentOverviewEntry[] {
  const entries: AgentOverviewEntry[] = [];
  for (const ws of workspaces) {
    for (const tab of ws.tabs) {
      if (tab.file) continue;
      for (const leaf of collectLeaves(tab.root)) {
        if (!leaf.agent) continue;
        const state = classify(
          leaf.id,
          waiting,
          active,
          everActive,
          focusedPaneId,
          hookState
        );
        entries.push({
          kind: leaf.agent.kind,
          command: leaf.agent.command,
          tabId: tab.id,
          tabName: tab.customName?.trim() || tab.name,
          tabIcon: tab.icon,
          paneId: leaf.id,
          state,
          workspaceId: ws.id,
          workspaceName: ws.name,
          workspaceIcon: ws.icon,
        });
      }
    }
  }
  // 稳定排序：只按 rank 降序，同 rank 保持插入（遍历）顺序。
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => RANK[b.e.state] - RANK[a.e.state] || a.i - b.i)
    .map(({ e }) => e);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/lib/agent-overview.test.ts`
Expected: PASS，全部 5 个用例通过。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent-overview.ts src/lib/agent-overview.test.ts
git commit -m "feat: add collectAllAgents pure aggregator for agent overview"
```

---

## Chunk 2: 快捷键 action

### Task 3: app-shortcut.ts 新增 overview action（TDD）

**Files:**
- Modify: `src/lib/app-shortcut.ts:26-36,65-76`
- Test: `src/lib/app-shortcut.test.ts`（已存在，追加用例）

- [ ] **Step 1: 追加失败测试**

在 `src/lib/app-shortcut.test.ts` 里追加（放到现有 describe 块内，风格对齐已有 palette/`case "k"` 的测试）：

```ts
it("Cmd+O (mac) -> overview", () => {
  expect(
    matchAppShortcut(
      { code: "KeyO", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
      true
    )
  ).toEqual({ action: "overview" });
});

it("Ctrl+Shift+O (linux) -> overview", () => {
  expect(
    matchAppShortcut(
      { code: "KeyO", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false },
      false
    )
  ).toEqual({ action: "overview" });
});

it("Cmd+Shift+O (mac, sub held) -> null (O 无 sub 变体)", () => {
  expect(
    matchAppShortcut(
      { code: "KeyO", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false },
      true
    )
  ).toBeNull();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/lib/app-shortcut.test.ts`
Expected: FAIL，overview 用例得到 `null` 而非 `{action:"overview"}`。

- [ ] **Step 3: 实现**

在 `src/lib/app-shortcut.ts` 的 `AppShortcut` 联合类型里（第 31 行 `search` 之后）加一行：

```ts
  | { action: "overview" }
```

在 `switch (key)` 的无 sub 变体分组里（`case "f"` 之后、`// Has a sub-variant.` 之前）加：

```ts
    case "o":
      return sub ? null : { action: "overview" };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/lib/app-shortcut.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/app-shortcut.ts src/lib/app-shortcut.test.ts
git commit -m "feat: bind Cmd+O / Ctrl+Shift+O to overview action"
```

---

## Chunk 3: AgentOverview 组件 + 样式

### Task 4: AgentOverview.tsx 组件

**Files:**
- Create: `src/components/AgentOverview.tsx`

- [ ] **Step 1: 写组件**

创建 `src/components/AgentOverview.tsx`：

```tsx
// 全局 Agent 透视图浮层：跨所有 workspace 以卡片网格展示每一个运行着 coding
// agent 的 pane（含空闲），每卡内嵌该 pane 的终端尾部静态文本快照。点击 / 回车
// 跳转到该 agent（切换 workspace/tab/pane、清除 attention、滚到底）并关闭浮层。
//
// 预览是静态快照：仅在挂载时对每个 pane 抓一次 getSessionText，取尾部若干行。
// 复用 WorkspacePalette 的 .modal-backdrop 浮层范式；网格用固定列数 OVERVIEW_COLS
// 以让方向键的行/列换算确定。

import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";
import { useAttentionStore, clearAttentionMany } from "../stores/attention-store";
import { useActivityStore } from "../stores/activity-store";
import { useHookStateStore } from "../stores/hook-state-store";
import { useFocusedPaneId } from "../lib/use-focused-pane";
import { collectAllAgents, OVERVIEW_COLS } from "../lib/agent-overview";
import { type AgentKind } from "../lib/workspace-agents";
import { collectLeafIds } from "../lib/pane-tree";
import { getSessionText, scrollSessionToBottom } from "../lib/terminal-manager";

const KIND_LABEL: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "opencode",
};

/** 预览取终端尾部的行数（长预览）。 */
const PREVIEW_LINES = 24;

export function AgentOverview({ onClose }: { onClose: () => void }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);
  const waiting = useAttentionStore((s) => s.waiting);
  const active = useActivityStore((s) => s.active);
  const everActive = useActivityStore((s) => s.everActive);
  const hookState = useHookStateStore((s) => s.state);
  const focusedPaneId = useFocusedPaneId();

  const entries = useMemo(
    () =>
      collectAllAgents(
        workspaces,
        waiting,
        active,
        everActive,
        focusedPaneId,
        hookState
      ),
    [workspaces, waiting, active, everActive, focusedPaneId, hookState]
  );

  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 静态快照：仅挂载时抓一次每个 pane 的终端尾部文本。
  const previews = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries) {
      const text = getSessionText(e.paneId);
      const tail = text.split("\n").slice(-PREVIEW_LINES).join("\n").trim();
      map.set(e.paneId, tail);
    }
    return map;
    // 故意只依赖挂载（entries 首帧）——不随信号变化重抓。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 挂载后聚焦浮层容器以接管键盘。
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // cursor 越界时收敛（entries 变短的极端情况）。
  useEffect(() => {
    if (cursor > entries.length - 1) setCursor(Math.max(0, entries.length - 1));
  }, [entries.length, cursor]);

  // 保持选中卡片可见。
  useEffect(() => {
    const el = listRef.current?.children[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function jumpTo(e: (typeof entries)[number]) {
    setActiveWorkspace(e.workspaceId);
    setActiveTab(e.workspaceId, e.tabId);
    setActivePane(e.workspaceId, e.tabId, e.paneId);
    const targetWs = workspaces.find((w) => w.id === e.workspaceId);
    const targetTab = targetWs?.tabs.find((t) => t.id === e.tabId);
    if (targetTab) clearAttentionMany(collectLeafIds(targetTab.root));
    scrollSessionToBottom(e.paneId);
    onClose();
  }

  function onKeyDown(ev: React.KeyboardEvent) {
    if (!entries.length) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onClose();
      }
      return;
    }
    const n = entries.length;
    if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const pick = entries[cursor];
      if (pick) jumpTo(pick);
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      setCursor((c) => (c + 1) % n);
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      setCursor((c) => (c - 1 + n) % n);
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setCursor((c) => Math.min(n - 1, c + OVERVIEW_COLS));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setCursor((c) => Math.max(0, c - OVERVIEW_COLS));
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="agent-overview"
        ref={rootRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="agent-overview-head">
          <span className="agent-overview-title">Agents</span>
          <span className="agent-overview-count">{entries.length}</span>
        </div>
        {entries.length === 0 ? (
          <div className="agent-overview-empty">当前没有运行中的 agent</div>
        ) : (
          <div
            className="agent-overview-grid"
            ref={listRef}
            style={{ gridTemplateColumns: `repeat(${OVERVIEW_COLS}, 1fr)` }}
          >
            {entries.map((e, i) => (
              <button
                key={e.paneId}
                type="button"
                className={
                  "agent-card " + e.state + (i === cursor ? " active" : "")
                }
                onMouseEnter={() => setCursor(i)}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  jumpTo(e);
                }}
              >
                <div className="agent-card-head">
                  <span className={"agent-card-dot " + e.state} aria-hidden="true" />
                  <span className="agent-card-kind">{KIND_LABEL[e.kind]}</span>
                  <span className="agent-card-ws">
                    {e.workspaceIcon && (
                      <span className="agent-card-ws-icon">{e.workspaceIcon}</span>
                    )}
                    {e.workspaceName}
                  </span>
                </div>
                <div className="agent-card-tab">
                  {e.tabIcon && <span className="agent-card-tab-icon">{e.tabIcon}</span>}
                  {e.tabName}
                </div>
                <pre className="agent-card-preview">
                  {previews.get(e.paneId) || "（无输出）"}
                </pre>
              </button>
            ))}
          </div>
        )}
        <div className="agent-overview-hint">
          ↑↓←→ navigate · ↵ jump · esc close
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过。若报 `PaneAgent` 字段（如 `sessionId`）不匹配，以 `src/lib/types.ts` 实际定义为准调整 —— 组件只用到 `leaf.agent.kind`/`command`，不依赖其它字段。

- [ ] **Step 3: Commit**

```bash
git add src/components/AgentOverview.tsx
git commit -m "feat: add AgentOverview card-grid overlay component"
```

---

### Task 5: 样式

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: 追加样式**

在 `src/styles.css` 末尾追加（`.modal-backdrop` 已由 palette 提供，这里只加透视图专属样式）。**CSS 变量用本 app 实际的 Tokyo Night 调色板**：`--bg-dark`/`--bg-medium`/`--bg-light`/`--fg`/`--fg-dim`/`--accent`（先 `grep -n "^\s*--" src/styles.css` 确认这些变量名，若略有差异以实际为准）：

```css
/* Agent 透视图浮层 */
.agent-overview {
  width: min(1100px, 92vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-medium, #1b1b1b);
  border: 1px solid var(--bg-light, #333);
  border-radius: 10px;
  padding: 14px;
  outline: none;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.agent-overview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.agent-overview-title {
  font-weight: 600;
}
.agent-overview-count {
  color: var(--fg-dim, #888);
  font-variant-numeric: tabular-nums;
}
.agent-overview-empty {
  padding: 40px 0;
  text-align: center;
  color: var(--fg-dim, #888);
}
.agent-overview-grid {
  display: grid;
  gap: 10px;
  overflow-y: auto;
  padding: 2px;
}
.agent-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
  padding: 10px;
  border: 1px solid var(--bg-light, #333);
  border-left-width: 3px;
  border-radius: 8px;
  background: var(--bg-dark, #222);
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.agent-card.active {
  outline: 2px solid var(--accent, #4a90d9);
}
.agent-card.executing { border-left-color: #2a4; }
.agent-card.waiting   { border-left-color: #6f6; }
.agent-card.idle      { border-left-color: #555; }
.agent-card.attention { border-left-color: #e90; }
.agent-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.agent-card-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #555;
  flex: none;
}
.agent-card-dot.executing { background: #2a4; animation: agent-blink 1.2s infinite; }
.agent-card-dot.waiting   { background: #6f6; }
.agent-card-dot.idle      { background: #555; }
.agent-card-dot.attention { background: #e90; animation: attention-pulse 1.2s infinite; }
.agent-card-kind { font-weight: 600; }
.agent-card-ws { margin-left: auto; color: var(--fg-dim, #888); }
.agent-card-ws-icon { margin-right: 3px; }
.agent-card-tab {
  font-size: 12px;
  color: var(--fg, #ccc);
}
.agent-card-tab-icon { margin-right: 4px; }
.agent-card-preview {
  margin: 0;
  height: 240px;
  overflow: auto;
  font-family: var(--terminal-font, monospace);
  font-size: 11px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bg-dark, #111);
  color: var(--fg, #cdd);
  border-radius: 6px;
  padding: 6px 8px;
}
.agent-overview-hint {
  margin-top: 10px;
  font-size: 11px;
  color: var(--fg-dim, #888);
  text-align: center;
}
```

> 注：`agent-blink` / `attention-pulse` 关键帧已在 styles.css 中为状态栏定义（reviewer 已确认存在），直接复用，不要重复定义。`--terminal-font` 若不存在则退化到 `monospace` 即可（预览是快照文本，字体非关键）。

- [ ] **Step 2: 类型检查（确保没破坏构建）**

Run: `npx tsc --noEmit`
Expected: 通过（CSS 不影响 tsc，但确认无误）。

- [ ] **Step 3: Commit**

```bash
git add src/styles.css
git commit -m "style: add agent overview grid + card styles"
```

---

## Chunk 4: 三个入口接线

### Task 6: 快捷键 + 挂载（App.tsx）

**Files:**
- Modify: `src/App.tsx`（import、state、`case "overview"`、挂载、状态栏 prop）

- [ ] **Step 1: 加 import**

在 `src/App.tsx` 顶部 import 区（`WorkspacePalette` import 附近，约第 9 行）加：

```ts
import { AgentOverview } from "./components/AgentOverview";
```

- [ ] **Step 2: 加 state**

在 `const [paletteOpen, setPaletteOpen] = useState(false);`（约第 56 行）下面加：

```ts
  const [overviewOpen, setOverviewOpen] = useState(false);
```

- [ ] **Step 3: 加快捷键 case**

在 `switch (sc.action)` 里 `case "palette"` 块之后加：

```ts
        case "overview":
          consume();
          setOverviewOpen((open) => !open);
          return;
```

- [ ] **Step 4: 挂载组件 + 状态栏 prop**

把 `<WorkspaceStatusBar />`（约第 413 行）改为：

```tsx
            <WorkspaceStatusBar onOpenOverview={() => setOverviewOpen(true)} />
```

在 `{paletteOpen && (...)}` 块（约第 435 行）之后加：

```tsx
      {overviewOpen && <AgentOverview onClose={() => setOverviewOpen(false)} />}
```

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 报 `WorkspaceStatusBar` 不接受 `onOpenOverview` prop —— 下一个 Task 修。（若想分步 commit，可先跳过，与 Task 7 一起过 tsc。）

- [ ] **Step 6: 暂不 commit，接 Task 7**

---

### Task 7: 状态栏按钮（WorkspaceStatusBar.tsx）

**Files:**
- Modify: `src/components/WorkspaceStatusBar.tsx`

- [ ] **Step 1: 加 prop + 按钮**

把函数签名：

```tsx
export function WorkspaceStatusBar() {
```

改为：

```tsx
export function WorkspaceStatusBar({
  onOpenOverview,
}: {
  onOpenOverview: () => void;
}) {
```

在 `return (...)` 的 `<div className="ws-statusbar" ...>` 内、`<span className="ws-statusbar-summary">…</span>` 之后（chips 之前或之后皆可，放 summary 之后最顺手）加一个按钮：

```tsx
      <button
        type="button"
        className="ws-statusbar-overview"
        title="打开 Agent 透视图 (⌘O)"
        onClick={onOpenOverview}
      >
        ⤢
      </button>
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过（App.tsx 传的 prop 现在匹配了）。

- [ ] **Step 3: 加按钮样式（styles.css）**

在 `src/styles.css` 追加：

```css
.ws-statusbar-overview {
  margin-left: 8px;
  background: transparent;
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  color: inherit;
  cursor: pointer;
  padding: 1px 7px;
  font-size: 12px;
  opacity: 0.7;
}
.ws-statusbar-overview:hover { opacity: 1; }
```

- [ ] **Step 4: 运行完整测试 + 类型检查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全部测试 PASS，tsc 通过。

- [ ] **Step 5: Commit（含 Task 6 的 App.tsx 改动）**

```bash
git add src/App.tsx src/components/WorkspaceStatusBar.tsx src/styles.css
git commit -m "feat: wire overview shortcut, mount, and status-bar button"
```

---

### Task 8: 命令面板动作行（WorkspacePalette.tsx）

**Files:**
- Modify: `src/components/WorkspacePalette.tsx`
- Modify: `src/App.tsx:435-436`（给 palette 传 `onOpenOverview`）

- [ ] **Step 1: 加 prop**

把 `WorkspacePalette` 签名：

```tsx
export function WorkspacePalette({ onClose }: { onClose: () => void }) {
```

改为：

```tsx
export function WorkspacePalette({
  onClose,
  onOpenOverview,
}: {
  onClose: () => void;
  onOpenOverview: () => void;
}) {
```

- [ ] **Step 2: 顶部渲染固定动作行**

在 `<div className="palette-list" ref={listRef}>` 内、`{matches.length === 0 ? ... }` 之前，插入一条固定动作行（只在无查询或查询能匹配 "overview/agent/透视" 时显示；为简单起见这里始终显示在最顶，回车由方向键逻辑覆盖，见 Step 3 的取舍说明）：

```tsx
          <div
            className="palette-row palette-action"
            onMouseDown={(e) => {
              e.preventDefault();
              onOpenOverview();
              onClose();
            }}
          >
            <span className="palette-icon">⤢</span>
            <span className="palette-ws">打开 Agent 透视图</span>
          </div>
```

> **取舍说明（重要）**：现有面板的 `cursor`/`Enter`/方向键逻辑只索引 `matches`（tab 列表），不含这条固定动作行。为避免改动键盘导航索引模型带来的复杂度与回归风险，这条动作行**只支持鼠标点击**，键盘 Enter 仍作用于 `matches`。这是刻意的最小改动。若后续要让它可键盘选中，需把它并入一个统一的可选列表——不在本次范围（YAGNI）。

- [ ] **Step 3: App.tsx 传 prop**

把 `src/App.tsx` 的：

```tsx
      {paletteOpen && (
        <WorkspacePalette onClose={() => setPaletteOpen(false)} />
      )}
```

改为：

```tsx
      {paletteOpen && (
        <WorkspacePalette
          onClose={() => setPaletteOpen(false)}
          onOpenOverview={() => setOverviewOpen(true)}
        />
      )}
```

- [ ] **Step 4: 动作行样式（styles.css）**

```css
.palette-row.palette-action {
  border-bottom: 1px solid var(--border, #333);
  opacity: 0.9;
}
```

- [ ] **Step 5: 类型检查 + 全量测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 通过。

- [ ] **Step 6: Commit**

```bash
git add src/components/WorkspacePalette.tsx src/App.tsx src/styles.css
git commit -m "feat: add 'open agent overview' action row to command palette"
```

---

## Chunk 5: 文档

### Task 9: 更新 CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 新增架构小节**

在 `CLAUDE.md` 的 `### Workspace agent status bar` 小节**之后**，新增一节：

```markdown
### Agent overview (global agent perspective)

A modal overlay (`Cmd+O` / `Ctrl+Shift+O`, the status-bar ⤢ button, or a command-palette action row) that rolls up EVERY coding-agent pane across ALL workspaces into a card grid — the cross-workspace view the status bar (current-workspace only) can't give. Pure/UI split:

- **Aggregation (pure)** — `src/lib/agent-overview.ts` `collectAllAgents(workspaces, waiting, active, everActive, focusedPaneId?, hookState?)` walks every workspace → tab (file tabs skipped) → `collectLeaves`, keeps panes with `leaf.agent` (INCLUDING idle), classifies each via the shared `classify` exported from `workspace-agents.ts` (single source of truth), and sorts by urgency (attention > executing > waiting > idle; stable within a rank). Returns `AgentOverviewEntry[]` = `WorkspaceAgentEntry` + `{workspaceId, workspaceName, workspaceIcon}`. `OVERVIEW_COLS = 3` is the fixed grid column count so arrow-key row/col math is deterministic. Unit-tested.
- **UI** — `src/components/AgentOverview.tsx` reuses `WorkspacePalette`'s `.modal-backdrop` overlay. Preview is a STATIC SNAPSHOT: on mount only, it calls `getSessionText(paneId)` per entry and renders the tail ~24 lines (`getSessionText` serializes the in-memory xterm buffer, so it works even for detached/off-screen panes). No polling. Each card shows a status dot (executing = blinking green, waiting = steady bright green, idle = dim, attention = pulsing amber), kind, workspace/tab names, and the preview. Arrow keys move the cursor (←→ by 1, ↑↓ by `OVERVIEW_COLS`), Enter/click jumps and closes. Jump = `setActiveWorkspace` → `setActiveTab` → `setActivePane` → `clearAttentionMany(targetTab.root)` → `scrollSessionToBottom` → `onClose` (note: `setActiveWorkspace` is required because this is cross-workspace, unlike the status bar's same-workspace `jumpTo`; the tab is resolved against the TARGET workspace, not the active one).
- **Entry points** — shortcut `"overview"` action in `app-shortcut.ts` (base action, no sub-variant, like `palette`); `overviewOpen` state + mount in `App.tsx`; `onOpenOverview` prop on `WorkspaceStatusBar` (⤢ button) and `WorkspacePalette` (a mouse-only fixed action row at the list top — the palette's keyboard cursor still only indexes the tab matches, deliberately).
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document agent overview in CLAUDE.md"
```

---

## 最终验收

- [ ] **全量测试**：`npx vitest run` — 全绿。
- [ ] **类型检查**：`npx tsc --noEmit` — 无错误。
- [ ] **构建**：`npm run build` — 成功（tsc + Vite）。
- [ ] **手动验证（可选，需 GUI）**：`npm run tauri:dev`，起多个 workspace/tab 跑 agent，按 `Cmd+O`（mac）打开透视图，确认：卡片按紧急度排序、预览显示终端尾部内容、方向键 + 回车跳转并关闭、状态栏 ⤢ 按钮与命令面板动作行都能打开。
