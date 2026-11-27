const english = {
  jumpPlaceholder: "Jump to workspace / tab…",
  openAgentOverview: "Open Agent Overview",
  noMatches: "No matches",
  current: "current",
  paletteHint: "↑↓ navigate · ↵ jump · esc close",
  agents: "Agents",
  noAgents: "No running agents",
  noOutput: "(no output)",
  overviewHint: "↑↓←→ navigate · ↵ jump · esc close",
};

const chinese: typeof english = {
  jumpPlaceholder: "跳转到工作区或标签页…",
  openAgentOverview: "打开 Agent 透视图",
  noMatches: "无匹配结果",
  current: "当前",
  paletteHint: "↑↓ 选择 · ↵ 跳转 · esc 关闭",
  agents: "智能体",
  noAgents: "当前没有运行中的智能体",
  noOutput: "（无输出）",
  overviewHint: "↑↓←→ 选择 · ↵ 跳转 · esc 关闭",
};

export function workspaceNavigationCopy(locale = globalThis.navigator?.language) {
  return /^zh(?:-|$)/i.test(locale ?? "") ? chinese : english;
}
