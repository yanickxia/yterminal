import { describe, it, expect, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import {
  computeTerminalUrlLinks,
  computeUrlLinks,
  isContinuation,
  isValidUrl,
  urlLinkAtPosition,
  type UrlRow,
} from "./terminal-url-links";

describe("computeTerminalUrlLinks buffer bounds", () => {
  async function withTerminal(
    output: string,
    check: (term: Terminal) => void,
    scrollback = 0
  ) {
    const term = new Terminal({
      allowProposedApi: true,
      cols: 20,
      rows: 3,
      scrollback,
    });
    try {
      await new Promise<void>((resolve) => term.write(output, resolve));
      const buf = term.buffer.active;
      const getLine = buf.getLine.bind(buf);
      // xterm 5.5 wraps out-of-range reads around its circular storage.
      // Throw at the boundary so a regression fails without hanging Vitest.
      vi.spyOn(buf, "getLine").mockImplementation((index) => {
        if (index < 0 || index >= buf.length) {
          throw new Error(`out-of-bounds buffer read: ${index}/${buf.length}`);
        }
        return getLine(index);
      });
      check(term);
    } finally {
      term.dispose();
    }
  }

  it("finishes hovering every row of an alternate screen painted with spaces", async () => {
    await withTerminal("\x1b[?1049h" + " ".repeat(60), (term) => {
      expect(term.buffer.active.type).toBe("alternate");
      for (let row = 1; row <= term.buffer.active.length; row++) {
        expect(computeTerminalUrlLinks(term, row)).toEqual([]);
      }
    });
  });

  it("stops at a full normal scrollback buffer after circular rollover", async () => {
    await withTerminal(
      "x".repeat(240),
      (term) => {
        expect(term.buffer.active.length).toBe(5);
        for (let row = 1; row <= term.buffer.active.length; row++) {
          expect(computeTerminalUrlLinks(term, row)).toEqual([]);
        }
      },
      2
    );
  });

  it("retains a hard-wrapped URL ending in the final column of the screen", async () => {
    const url = "https://example.com/" + "x".repeat(20);
    const output = "\x1b[?1049h" + " ".repeat(20) + "\r\n" +
      url.slice(0, 20) + "\r\n" + url.slice(20);
    await withTerminal(output, (term) => {
      const expected = [{ url, startRow: 1, startCol: 0, endRow: 2, endCol: 20 }];
      expect(computeTerminalUrlLinks(term, 1)).toEqual([]);
      expect(computeTerminalUrlLinks(term, 2)).toEqual(expected);
      expect(computeTerminalUrlLinks(term, 3)).toEqual(expected);
    });
  });

  it("rejects stale or invalid requested rows without reading circular storage", async () => {
    await withTerminal("\x1b[?1049h" + " ".repeat(60), (term) => {
      for (const row of [0, -1, 4, 1.5, NaN, Infinity]) {
        expect(computeTerminalUrlLinks(term, row)).toEqual([]);
      }
      expect(term.buffer.active.getLine).not.toHaveBeenCalled();
    });
  });

  it("keeps real xterm cell coordinates for URLs following wide characters", async () => {
    await withTerminal("\x1b[?1049h访问：https://x.io", (term) => {
      expect(computeTerminalUrlLinks(term, 1)).toEqual([
        { url: "https://x.io", startRow: 0, startCol: 6, endRow: 0, endCol: 18 },
      ]);
    });
  });
});

const LONG_URL =
  "https://code.byted.org/machinelearning/super-ops/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fnacos-loading-state&source_branch=feat%2Fnacos-loading-state";

function row(text: string, isWrapped = false): UrlRow {
  return { text, isWrapped };
}

describe("isValidUrl", () => {
  it("accepts a normal https URL", () => {
    expect(isValidUrl("https://example.com/a?b=c")).toBe(true);
  });
  it("accepts the long MR URL", () => {
    expect(isValidUrl(LONG_URL)).toBe(true);
  });
  it("rejects a bare scheme", () => {
    expect(isValidUrl("https://")).toBe(false);
  });
  it("rejects non-url text", () => {
    expect(isValidUrl("not a url")).toBe(false);
  });
});

describe("isContinuation", () => {
  it("true for a soft-wrapped row", () => {
    expect(isContinuation("short", true, 80)).toBe(true);
  });
  it("true when the previous row fills the width (hard wrap)", () => {
    expect(isContinuation("x".repeat(80), false, 80)).toBe(true);
    expect(isContinuation("x".repeat(81), false, 80)).toBe(true);
  });
  it("false when the previous row is short and not soft-wrapped", () => {
    expect(isContinuation("x".repeat(40), false, 80)).toBe(false);
  });
  it("false when cols is unknown (0)", () => {
    expect(isContinuation("x".repeat(80), false, 0)).toBe(false);
  });
});

describe("computeUrlLinks", () => {
  it("finds a URL on a single line", () => {
    const links = computeUrlLinks([row("see https://example.com/x here")], 80);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/x");
    expect(links[0].startRow).toBe(0);
    expect(links[0].endRow).toBe(0);
    expect(links[0].startCol).toBe(4);
    expect(links[0].endCol).toBe(4 + "https://example.com/x".length);
  });

  it("returns nothing when there is no URL", () => {
    expect(computeUrlLinks([row("just some plain text")], 80)).toEqual([]);
  });

  it("stitches a soft-wrapped URL across two rows (isWrapped)", () => {
    const cols = 100;
    const a = LONG_URL.slice(0, cols);
    const b = LONG_URL.slice(cols);
    const links = computeUrlLinks([row(a, false), row(b, true)], cols);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe(LONG_URL);
    expect(links[0].startRow).toBe(0);
    expect(links[0].startCol).toBe(0);
    expect(links[0].endRow).toBe(1);
    expect(links[0].endCol).toBe(b.length);
  });

  it("stitches a HARD-wrapped URL: continuation row has isWrapped=false but prev row fills cols", () => {
    // Simulate a CLI that prints the URL and hard-wraps at the terminal width.
    const cols = 100;
    const a = LONG_URL.slice(0, cols); // row exactly fills the width
    const b = LONG_URL.slice(cols);
    // isWrapped is FALSE for the continuation — the stock addon would miss this.
    const links = computeUrlLinks([row(a, false), row(b, false)], cols);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe(LONG_URL);
    expect(links[0].startRow).toBe(0);
    expect(links[0].endRow).toBe(1);
    expect(links[0].endCol).toBe(b.length);
  });

  it("does NOT join when the previous row is short (real newline before the URL)", () => {
    const cols = 100;
    const links = computeUrlLinks(
      [row("MR 创建链接:", false), row("https://example.com/x", false)],
      cols
    );
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/x");
    expect(links[0].startRow).toBe(1);
    expect(links[0].startCol).toBe(0);
  });

  it("spans three hard-wrapped rows", () => {
    const cols = 60;
    const a = LONG_URL.slice(0, cols);
    const b = LONG_URL.slice(cols, cols * 2);
    const c = LONG_URL.slice(cols * 2);
    const links = computeUrlLinks(
      [row(a, false), row(b, false), row(c, false)],
      cols
    );
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe(LONG_URL);
    expect(links[0].startRow).toBe(0);
    expect(links[0].endRow).toBe(2);
  });

  it("finds multiple URLs on one line", () => {
    const links = computeUrlLinks(
      [row("a https://x.com/1 b https://y.com/2 c")],
      80
    );
    expect(links.map((l) => l.url)).toEqual([
      "https://x.com/1",
      "https://y.com/2",
    ]);
  });

  it("trims trailing sentence punctuation from the URL", () => {
    const links = computeUrlLinks([row("go to https://example.com/x.")], 80);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com/x");
  });
});

describe("urlLinkAtPosition", () => {
  const wrappedLink = {
    url: "https://example.com/a-long-url",
    startRow: 4,
    startCol: 20,
    endRow: 6,
    endCol: 7,
  };

  it("hit-tests every row of a wrapped URL with an exclusive end", () => {
    const links = [wrappedLink];

    expect(urlLinkAtPosition(links, 4, 19)).toBeNull();
    expect(urlLinkAtPosition(links, 4, 20)).toBe(wrappedLink);
    expect(urlLinkAtPosition(links, 4, 79)).toBe(wrappedLink);
    expect(urlLinkAtPosition(links, 5, 0)).toBe(wrappedLink);
    expect(urlLinkAtPosition(links, 5, 79)).toBe(wrappedLink);
    expect(urlLinkAtPosition(links, 6, 6)).toBe(wrappedLink);
    expect(urlLinkAtPosition(links, 6, 7)).toBeNull();
    expect(urlLinkAtPosition(links, 3, 20)).toBeNull();
    expect(urlLinkAtPosition(links, 7, 0)).toBeNull();
  });

  it("respects both bounds for a single-row URL", () => {
    const link = {
      url: "https://example.com",
      startRow: 2,
      startCol: 5,
      endRow: 2,
      endCol: 24,
    };

    expect(urlLinkAtPosition([link], 2, 4)).toBeNull();
    expect(urlLinkAtPosition([link], 2, 5)).toBe(link);
    expect(urlLinkAtPosition([link], 2, 23)).toBe(link);
    expect(urlLinkAtPosition([link], 2, 24)).toBeNull();
  });
});
