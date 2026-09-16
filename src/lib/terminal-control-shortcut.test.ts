import { describe, expect, it, vi } from "vitest";
import { createControlEnterHandler } from "./terminal-control-shortcut";

function key(overrides = {}) {
  return {
    type: "keydown", key: "Enter", ctrlKey: false, metaKey: false,
    shiftKey: false, altKey: false, isComposing: false, keyCode: 13,
    repeat: false, preventDefault: vi.fn(), ...overrides,
  };
}

function setup() {
  let enabled = true;
  let readOnly = true;
  const takeControl = vi.fn<() => Promise<void>>().mockResolvedValue();
  const onError = vi.fn();
  const handler = createControlEnterHandler({
    enabled: () => enabled, readOnly: () => readOnly, takeControl, onError,
  });
  const write = vi.fn();
  const dispatch = (event = key()) => {
    const consumed = handler(event);
    if (!consumed && event.type === "keydown" && !readOnly) write("\r");
    return consumed;
  };
  return {
    handler, dispatch, write, takeControl, onError,
    setEnabled: (value: boolean) => { enabled = value; },
    setReadOnly: (value: boolean) => { readOnly = value; },
  };
}

describe("Enter to take control", () => {
  it("consumes the takeover press, then lets a fresh Enter submit", async () => {
    const s = setup();
    s.takeControl.mockImplementation(async () => { s.setReadOnly(false); });
    const event = key();
    expect(s.dispatch(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(s.dispatch(key({ type: "keypress" }))).toBe(true);
    expect(s.dispatch(key({ repeat: true }))).toBe(true);
    expect(s.write).not.toHaveBeenCalled();
    expect(s.takeControl).toHaveBeenCalledOnce();
    s.dispatch(key({ type: "keyup" }));
    expect(s.dispatch()).toBe(false);
    expect(s.write).toHaveBeenCalledOnce();
  });

  it("does not send parallel requests while a takeover is pending", async () => {
    const s = setup();
    let finish!: () => void;
    s.takeControl.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    s.dispatch();
    s.dispatch(key({ type: "keyup" }));
    s.dispatch();
    s.dispatch(key({ repeat: true }));
    expect(s.takeControl).toHaveBeenCalledOnce();
    expect(s.write).not.toHaveBeenCalled();
    finish();
    await Promise.resolve();
  });

  it("reports failure and allows retry on a fresh press", async () => {
    const s = setup();
    const error = new Error("host offline");
    s.takeControl.mockRejectedValueOnce(error);
    s.dispatch();
    await Promise.resolve();
    expect(s.onError).toHaveBeenCalledWith(error);
    s.dispatch(key({ repeat: true }));
    expect(s.takeControl).toHaveBeenCalledOnce();
    s.dispatch();
    expect(s.takeControl).toHaveBeenCalledTimes(2);
    expect(s.write).not.toHaveBeenCalled();
  });

  it("reads the setting live without recreating the terminal", () => {
    const s = setup();
    s.setEnabled(false);
    expect(s.dispatch()).toBe(false);
    expect(s.takeControl).not.toHaveBeenCalled();
    s.setEnabled(true);
    expect(s.dispatch()).toBe(true);
    expect(s.takeControl).toHaveBeenCalledOnce();
  });

  it("leaves an already controlled terminal alone", () => {
    const s = setup();
    s.setReadOnly(false);
    expect(s.dispatch()).toBe(false);
    expect(s.takeControl).not.toHaveBeenCalled();
    expect(s.write).toHaveBeenCalledOnce();
  });

  it.each([
    { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true },
    { isComposing: true }, { keyCode: 229 }, { key: "a" }, { type: "keypress" },
  ])("does not take control for modified/IME/non-Enter input: %j", (overrides) => {
    const s = setup();
    const event = key(overrides);
    expect(s.handler(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(s.takeControl).not.toHaveBeenCalled();
  });

  it("never starts a takeover from auto-repeat alone", () => {
    const s = setup();
    expect(s.dispatch(key({ repeat: true }))).toBe(true);
    expect(s.takeControl).not.toHaveBeenCalled();
  });
});
