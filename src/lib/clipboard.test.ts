import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { clipboardRead, clipboardWrite } from "./clipboard";

beforeEach(() => vi.resetAllMocks());

describe("clipboard", () => {
  it("reads through the command that coordinates native clipboard access", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("hello 中文\nsecond line");
    await expect(clipboardRead()).resolves.toBe("hello 中文\nsecond line");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("clipboard_read_text");
  });

  it("preserves empty clipboard text", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("");
    await expect(clipboardRead()).resolves.toBe("");
  });

  it("writes unchanged text through the same native coordination layer", async () => {
    const text = "hello 中文\nsecond line";
    await clipboardWrite(text);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("clipboard_write_text", { text });
  });

  it("propagates native errors to callers", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("clipboard unavailable");
    await expect(clipboardRead()).rejects.toBe("clipboard unavailable");
    vi.mocked(invoke).mockRejectedValueOnce("clipboard unavailable");
    await expect(clipboardWrite("")).rejects.toBe("clipboard unavailable");
  });
});
