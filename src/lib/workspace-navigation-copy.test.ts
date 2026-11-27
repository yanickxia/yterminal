import { expect, it } from "vitest";
import { workspaceNavigationCopy } from "./workspace-navigation-copy";

it("shows the Agent Overview action in the current UI language", () => {
  expect(workspaceNavigationCopy("en-US").openAgentOverview).toBe("Open Agent Overview");
  expect(workspaceNavigationCopy("zh-CN").openAgentOverview).toBe("打开 Agent 透视图");
  expect(workspaceNavigationCopy("zh-Hant-TW").openAgentOverview).toBe("打开 Agent 透视图");
  expect(workspaceNavigationCopy("fr-FR")).toEqual(workspaceNavigationCopy("en-US"));
});
