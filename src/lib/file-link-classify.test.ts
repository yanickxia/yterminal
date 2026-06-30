import { describe, it, expect } from "vitest";
import {
  basename,
  extname,
  isWebUrl,
  classifyViewable,
  classifyFilePath,
  resolvePath,
  looksLikePath,
  findPathSpans,
} from "./file-link-classify";

describe("basename", () => {
  it("returns the final segment", () => {
    expect(basename("/a/b/c.txt")).toBe("c.txt");
    expect(basename("c.txt")).toBe("c.txt");
  });
  it("handles trailing slashes and backslashes", () => {
    expect(basename("/a/b/")).toBe("b");
    expect(basename("C:\\a\\b\\file.md")).toBe("file.md");
  });
});

describe("extname", () => {
  it("returns lowercased extension without the dot", () => {
    expect(extname("README.MD")).toBe("md");
    expect(extname("/x/y/app.tsx")).toBe("tsx");
  });
  it("returns empty for no extension or dotfiles", () => {
    expect(extname("Makefile")).toBe("");
    expect(extname(".gitignore")).toBe("");
    expect(extname("/a/b/.env")).toBe("");
  });
});

describe("isWebUrl", () => {
  it("matches http and https", () => {
    expect(isWebUrl("http://example.com")).toBe(true);
    expect(isWebUrl("https://example.com/x")).toBe(true);
    expect(isWebUrl("  HTTPS://EXAMPLE  ")).toBe(true);
  });
  it("rejects non-web schemes and bare paths", () => {
    expect(isWebUrl("ftp://x")).toBe(false);
    expect(isWebUrl("/usr/local/bin")).toBe(false);
    expect(isWebUrl("file:///etc/hosts")).toBe(false);
  });
});

describe("classifyViewable", () => {
  it("maps known extensions to highlight languages", () => {
    expect(classifyViewable("a.ts")).toEqual({
      language: "typescript",
      markdown: false,
    });
    expect(classifyViewable("q.sql")).toEqual({
      language: "sql",
      markdown: false,
    });
    expect(classifyViewable("data.json")).toEqual({
      language: "json",
      markdown: false,
    });
  });
  it("flags markdown extensions", () => {
    expect(classifyViewable("notes.md")).toEqual({
      language: "markdown",
      markdown: true,
    });
    expect(classifyViewable("doc.mdx")).toEqual({
      language: "markdown",
      markdown: true,
    });
  });
  it("recognizes bare basenames", () => {
    expect(classifyViewable("/proj/Dockerfile")).toEqual({
      language: "dockerfile",
      markdown: false,
    });
    expect(classifyViewable("/proj/.bashrc")).toEqual({
      language: "bash",
      markdown: false,
    });
  });
  it("returns null for unknown types", () => {
    expect(classifyViewable("/bin/ls")).toBeNull();
    expect(classifyViewable("photo.png")).toBeNull();
  });
});

describe("classifyFilePath", () => {
  it("views recognized text types", () => {
    expect(classifyFilePath("/a/b.md")).toEqual({
      kind: "view",
      path: "/a/b.md",
      language: "markdown",
      markdown: true,
    });
  });
  it("os-opens unrecognized types", () => {
    expect(classifyFilePath("/a/image.png")).toEqual({
      kind: "os-open",
      path: "/a/image.png",
    });
  });
});

describe("resolvePath", () => {
  it("leaves absolute paths unchanged", () => {
    expect(resolvePath("/etc/hosts", "/home/u")).toBe("/etc/hosts");
  });
  it("expands ~ against home", () => {
    expect(resolvePath("~/notes.md", "/home/u", "/home/me")).toBe(
      "/home/me/notes.md"
    );
    expect(resolvePath("~", "/cwd", "/home/me")).toBe("/home/me");
  });
  it("joins relative paths against cwd and collapses segments", () => {
    expect(resolvePath("src/a.ts", "/proj")).toBe("/proj/src/a.ts");
    expect(resolvePath("./a.ts", "/proj")).toBe("/proj/a.ts");
    expect(resolvePath("../a.ts", "/proj/src")).toBe("/proj/a.ts");
  });
  it("strips a trailing :line:col suffix", () => {
    expect(resolvePath("src/a.ts:42:9", "/proj")).toBe("/proj/src/a.ts");
  });
});

describe("looksLikePath", () => {
  it("accepts separators, extensions and known basenames", () => {
    expect(looksLikePath("src/a.ts")).toBe(true);
    expect(looksLikePath("a.ts")).toBe(true);
    expect(looksLikePath("Dockerfile")).toBe(true);
    expect(looksLikePath("file.ts:42")).toBe(true);
  });
  it("rejects noise", () => {
    expect(looksLikePath("")).toBe(false);
    expect(looksLikePath("hello world")).toBe(false);
    expect(looksLikePath("12345")).toBe(false);
    expect(looksLikePath("https://x.com")).toBe(false);
    expect(looksLikePath("justaword")).toBe(false);
  });
});

describe("findPathSpans", () => {
  it("finds a bare path token with correct offsets", () => {
    const line = "open src/app.ts now";
    const spans = findPathSpans(line);
    expect(spans).toHaveLength(1);
    expect(spans[0].token).toBe("src/app.ts");
    expect(line.slice(spans[0].start, spans[0].end)).toBe("src/app.ts");
  });
  it("trims wrapping quotes and trailing punctuation", () => {
    const line = 'see "/a/b.md", please';
    const spans = findPathSpans(line);
    expect(spans).toHaveLength(1);
    expect(spans[0].token).toBe("/a/b.md");
    expect(line.slice(spans[0].start, spans[0].end)).toBe("/a/b.md");
  });
  it("keeps a :line:col suffix on the token", () => {
    const spans = findPathSpans("err at src/x.ts:42:9 here");
    expect(spans).toHaveLength(1);
    expect(spans[0].token).toBe("src/x.ts:42:9");
  });
  it("ignores web URLs and non-path words", () => {
    expect(findPathSpans("visit https://example.com today")).toEqual([]);
    expect(findPathSpans("just some plain words")).toEqual([]);
  });
  it("finds multiple paths on one line", () => {
    const spans = findPathSpans("a.ts and b.md");
    expect(spans.map((s) => s.token)).toEqual(["a.ts", "b.md"]);
  });
});
