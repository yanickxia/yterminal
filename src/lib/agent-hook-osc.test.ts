import { describe, it, expect } from "vitest";
import { parseAgentHookOsc } from "./agent-hook-osc";

describe("parseAgentHookOsc", () => {
  it("parses each live run-state", () => {
    expect(parseAgentHookOsc("notify;yt-agent;working")).toBe("working");
    expect(parseAgentHookOsc("notify;yt-agent;idle")).toBe("idle");
    expect(parseAgentHookOsc("notify;yt-agent;permission")).toBe("permission");
  });

  it("maps the ended signal", () => {
    expect(parseAgentHookOsc("notify;yt-agent;ended")).toBe("ended");
  });

  it("returns null for a real (non-yterminal) OSC 777 notification", () => {
    expect(parseAgentHookOsc("notify;Build Complete;All tests passed")).toBe(
      null
    );
  });

  it("returns null for an unknown state", () => {
    expect(parseAgentHookOsc("notify;yt-agent;bogus")).toBe(null);
  });

  it("returns null for a malformed / too-short payload", () => {
    expect(parseAgentHookOsc("notify;yt-agent")).toBe(null);
    expect(parseAgentHookOsc("notify")).toBe(null);
    expect(parseAgentHookOsc("")).toBe(null);
  });

  it("requires the yt-agent marker in the second field", () => {
    expect(parseAgentHookOsc("notify;other-agent;working")).toBe(null);
  });
});
