import { beforeEach, describe, expect, it } from "vitest";
import { useViewerStore } from "./viewer-store";

describe("viewer scroll positions", () => {
  beforeEach(() => {
    useViewerStore.setState({ files: {}, scrollTops: {} });
  });

  it("keeps an independent reading position for each file tab", () => {
    const store = useViewerStore.getState();

    store.setScrollTop("tab-a", 420);
    store.setScrollTop("tab-b", 75);

    expect(useViewerStore.getState().scrollTops).toEqual({
      "tab-a": 420,
      "tab-b": 75,
    });
  });

  it("clamps invalid positions and clears a position when the tab closes", () => {
    const store = useViewerStore.getState();
    store.setScrollTop("tab-a", Number.NaN);
    store.setScrollTop("tab-b", -10);
    store.setScrollTop("tab-c", 120.8);

    expect(useViewerStore.getState().scrollTops).toEqual({
      "tab-a": 0,
      "tab-b": 0,
      "tab-c": 120.8,
    });

    useViewerStore.getState().drop("tab-c");
    expect(useViewerStore.getState().scrollTops["tab-c"]).toBeUndefined();
  });
});
