import { describe, it, expect } from "vitest";
import { changeKind, splitPath } from "./git";

describe("changeKind", () => {
  it("maps untracked", () => {
    expect(changeKind("??")).toBe("untracked");
  });
  it("maps a plain modification (either column)", () => {
    expect(changeKind(" M")).toBe("modified");
    expect(changeKind("M ")).toBe("modified");
    expect(changeKind("MM")).toBe("modified");
  });
  it("maps additions", () => {
    expect(changeKind("A ")).toBe("added");
    expect(changeKind("AM")).toBe("added");
  });
  it("maps deletions in either column", () => {
    expect(changeKind(" D")).toBe("deleted");
    expect(changeKind("D ")).toBe("deleted");
  });
  it("maps renames", () => {
    expect(changeKind("R ")).toBe("renamed");
  });
});

describe("splitPath", () => {
  it("splits a nested path into name + dir", () => {
    expect(splitPath("proxy/client/service/regional.go")).toEqual({
      name: "regional.go",
      dir: "proxy/client/service",
    });
  });
  it("returns an empty dir for a top-level file", () => {
    expect(splitPath("README.md")).toEqual({ name: "README.md", dir: "" });
  });
});
