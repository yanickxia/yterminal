# Agent 透视图（Agent Overview）设计

日期：2026-07-12
状态：已批准，待实现

## 目标

新增一个全局透视图（overview）浮层，跨所有 workspace 汇总当前**所有含 coding agent（claude/codex/opencode）的 pane**，以卡片网格形式展示，每张卡片内嵌该 pane 的终端内容静态快照预览，点击卡片可快捷跳转到对应 agent 并关闭浮层。

这填补了现有 `WorkspaceStatusBar` 的能力空白——状态栏只显示**当前** workspace 的 agent，无法一眼看到其它 workspace 里正在跑或在等你输入的 agent。

## 范围决策（已与用户确认）

- **覆盖范围**：跨所有 workspace 的全局总览（不是只看当前 workspace）。
- **过滤**：显示所有 agent，**包含空闲（idle）** 的。
- **布局**：卡片网格（每个 agent 一张卡，卡内嵌终端预览）。
- **预览刷新**：静态快照——打开透视图那一刻对每个 pane 抓一次终端尾部文本，之后不轮询、不实时刷新。
- **预览行数**：长预览，取终端尾部约 24 行。
- **跳转行为**：点击/回车跳转后**自动关闭**透视图。
- **打开入口**：三个 —— 快捷键、状态栏按钮、命令面板条目。

## 非目标（YAGNI）

- 不做实时轮询/流式刷新预览（静态快照即可）。
- 不在卡片内嵌真正的 xterm 实例（避免与现有 attach/re-parent 机制冲突）。
- 不新增任何 Rust 代码、不新增持久化（纯 session 内瞬态 UI）。
- 不做预览内的搜索/过滤输入框（网格 + 键盘导航足够）。

## 架构

**全部逻辑在 TS，纯函数聚合 + React 浮层组件，零 Rust 改动、零持久化。** 复用现有 agent 信号体系（`attention-store` / `activity-store` / `hook-state-store`）与跳转 action，与 `WorkspaceStatusBar` 共享同一套状态分类逻辑（`classify`）。

### 新增 / 改动文件

| 文件 | 类型 | 作用 |
|---|---|---|
| `src/lib/agent-overview.ts` | 新增（纯函数） | `collectAllAgents(...)` 跨所有 workspace 聚合，返回 `AgentOverviewEntry[]`。 |
| `src/lib/agent-overview.test.ts` | 新增（单测） | 覆盖聚合、排序、空闲包含、文件 tab 跳过、空输入。 |
| `src/components/AgentOverview.tsx` | 新增（UI） | 卡片网格浮层，照搬 `WorkspacePalette` 的 `.modal-backdrop` + 键盘导航范式。 |
| `src/lib/workspace-agents.ts` | 改 | 导出私有的 `classify`，供 `agent-overview.ts` 复用，避免分类逻辑漂移。 |
| `src/lib/app-shortcut.ts` | 改 | `AppShortcut` action 联合类型加 `"overview"`，字母 `O` 绑定。 |
| `src/App.tsx` | 改 | `overviewOpen` state；快捷键 `case "overview"`；末尾挂载 `{overviewOpen && <AgentOverview onClose=… />}`。 |
| `src/components/WorkspaceStatusBar.tsx` | 改 | 增加一个"透视图"小按钮触发打开。 |
| `src/components/WorkspacePalette.tsx` | 改 | 顶部增加一条"打开 Agent 透视图"动作行。 |
| `src/styles.css` | 改 | `.agent-overview*` 网格与卡片样式。 |

## 数据结构

```ts
// src/lib/agent-overview.ts
import type { WorkspaceAgentEntry } from "./workspace-agents";

/** 一个 agent 条目，在 WorkspaceAgentEntry 基础上带上归属 workspace 信息。 */
export interface AgentOverviewEntry extends WorkspaceAgentEntry {
  workspaceId: string;
  workspaceName: string;
  workspaceIcon?: string;
}
```

`WorkspaceAgentEntry` 已含 `{ kind, command, tabId, tabName, tabIcon?, paneId, state }`。

## 纯函数：collectAllAgents

```ts
export function collectAllAgents(
  workspaces: Workspace[],
  waiting: Set<string>,
  active: Set<string>,
  everActive: Set<string>,
  focusedPaneId?: string,
  hookState?: Map<string, AgentHookState>
): AgentOverviewEntry[]
```

行为：
1. 遍历每个 workspace → `workspace.tabs`（跳过 `tab.file`）→ `collectLeaves(tab.root)`。
2. 只保留 `leaf.agent` 存在的 pane（含 idle）。
3. 每个 pane 用**复用自 `workspace-agents.ts` 的 `classify`** 判定 `state`（attention > executing > waiting > idle 优先级，`focusedPaneId` 抑制 waiting）。
4. 组装 `AgentOverviewEntry`，`tabName` 取 `tab.customName?.trim() || tab.name`。
5. **排序**：按紧急度分组降序 attention → executing → waiting → idle；同组内保持 workspace→tab→pane 的稳定顺序。这样"需要关注的"永远在前排。

`classify` 从 `workspace-agents.ts` 导出后由本模块与原有 summary 函数共享，单一实现。

## 组件：AgentOverview

### 打开时序

1. 用户触发（快捷键 / 状态栏按钮 / 命令面板行）→ `App.tsx` 的 `overviewOpen = true`。
2. `AgentOverview` 挂载，从 store 读实时信号：
   - `useWorkspaceStore(s => s.workspaces)`
   - `useAttentionStore(s => s.waiting)`
   - `useActivityStore(s => s.active)` / `useActivityStore(s => s.everActive)`
   - `useHookStateStore(s => s.state)`
   - `useFocusedPaneId()`
3. `useMemo` 调 `collectAllAgents(...)` 得到 `AgentOverviewEntry[]`。
4. **预览快照**：挂载时（一次性 `useEffect`）对每个 entry 调 `getSessionText(paneId)`，`split("\n").slice(-24)` 取尾部约 24 行，存入本地 state `Map<paneId, string>`。**只抓一次**，之后不刷新。

### 卡片内容

- 状态圆点 + agent kind（claude/codex/opencode）
- workspace 名 / tab 名（带 tabIcon）
- 终端尾部文本预览（等宽字体、只读、约 24 行、可滚动）
- 状态边框色：attention 琥珀、executing 绿、waiting 亮绿、idle 灰
- executing 状态圆点可复用现有 `agent-blink` 动画，attention 复用 `attention-pulse`（与状态栏一致）

### 键盘导航

- `Esc` 关闭。
- `↑/↓/←/→` 在网格里移动选中卡片（`selectedIndex` + 当前渲染列数推算行列）。
- `Enter` 跳转到选中卡片的 agent，然后关闭。
- 鼠标点击任意卡片 = 直接跳转并关闭。
- 挂载时自动聚焦浮层容器以接管键盘（照 `WorkspacePalette` 的 `ref` focus 模式）。

### 跳转实现（复用 StatusBar 三步）

```
setActiveWorkspace(wsId)
setActiveTab(wsId, tabId)
setActivePane(wsId, tabId, paneId)
clearAttentionMany(collectLeafIds(tab.root))
scrollSessionToBottom(paneId)
onClose()
```

## 打开入口

1. **快捷键**：`app-shortcut.ts` 新增 `"overview"` action，字母 `O`（overview，当前未占用）。遵循平台修饰键不变量：macOS `Cmd+Shift+O`，Linux/Windows `Ctrl+Shift+Alt+O`（O 作为 base action，走 `Cmd+Shift` / `Ctrl+Shift` 主链；具体 sub 变体由现有 matchAppShortcut 结构决定，实现时对齐现有 action 的绑定形态）。`App.tsx` 的 `case "overview"` 里 `consume()` + `setOverviewOpen(v => !v)`。
2. **状态栏按钮**：`WorkspaceStatusBar.tsx` 增加一个小图标按钮，点击调用打开回调（通过 props 从 App 传入，或直接用一个轻量 store —— 实现时二选一，倾向 props 保持依赖单向）。
3. **命令面板条目**：`WorkspacePalette.tsx` 当前是纯 workspace/tab 切换器（无"动作"概念）。在其列表**顶部**插入一条特殊的固定动作行"打开 Agent 透视图"，选中/回车时不做 tab 切换而是触发打开透视图回调并关闭面板。

## 错误处理 / 边界

- `getSessionText` 返回 `""`（session 不存在 / 已 dispose）→ 卡片预览区显示占位"（无输出）"，不报错。
- 没有任何 agent → 整屏空态提示"当前没有运行中的 agent"。
- 预览对 detached pane 依然有效：`getSessionText` 序列化的是内存中的 xterm buffer（terminal-manager 缓存 Terminal 实例而非销毁），即使 pane 当前不在屏幕上也能取到文本。
- 跳转目标 pane 已不存在（极端竞态）→ `setActive*` 系列 action 对不存在 id 是安全 no-op，不崩溃。
- 静态快照：预览文本只在挂载时抓一次；透视图打开期间 store 结构变化会触发列表重渲染，但预览 Map 不重新抓取（与"静态快照"决策一致）。

## 测试

- `agent-overview.test.ts`：
  - `collectAllAgents` 跨多 workspace 聚合正确
  - 空闲（idle）agent 也被包含
  - 排序按紧急度分组（attention → executing → waiting → idle）
  - 文件 tab（`tab.file`）被跳过
  - 空输入返回空数组
  - 无 agent 的 workspace 不产生条目
- 分类逻辑：`classify` 导出后由 `workspace-agents` 现有测试继续覆盖，单一实现无重复。
- UI 组件按仓库惯例：纯逻辑已抽到 `agent-overview.ts` 测试；`AgentOverview.tsx` 组件本身若无 jsdom 设置则不强测（符合"DOM 测试需显式 jsdom"约定）。
- `npx tsc --noEmit` 必须通过。

## 与既有约定的一致性

- 遵循 pure/IO/UI 分层：纯聚合在 `agent-overview.ts`，UI 在组件，无新 IO。
- 遵循键盘快捷键平台修饰键不变量（macOS Cmd / Linux Ctrl+Shift，bare Ctrl 永不拦截）。
- 浮层照搬 `WorkspacePalette` 的 `.modal-backdrop` 模态范式。
- 更新 `CLAUDE.md`：在架构章节新增一节描述 Agent 透视图（与本仓库"改架构同步改 CLAUDE.md"约定一致）。
