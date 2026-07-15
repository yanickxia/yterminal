import { describe, expect, it } from "vitest";
import { ACTIVITY_IDLE_MS, activityIdleDelay } from "./activity-store";

describe("activityIdleDelay", () => {
  it("returns the remaining time before a pane becomes idle", () => {
    expect(activityIdleDelay(1_200, 1_000)).toBe(ACTIVITY_IDLE_MS - 200);
  });

  it("returns null at and after the idle deadline", () => {
    expect(activityIdleDelay(1_800, 1_000)).toBeNull();
    expect(activityIdleDelay(2_000, 1_000)).toBeNull();
  });

  it("supports an explicit idle window", () => {
    expect(activityIdleDelay(1_010, 1_000, 25)).toBe(15);
    expect(activityIdleDelay(1_025, 1_000, 25)).toBeNull();
  });
});
