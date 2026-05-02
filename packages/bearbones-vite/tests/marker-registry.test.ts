import { beforeEach, describe, it, expect } from "vitest";
import {
  __resetRegistry,
  buildRelationSelector,
  listMarkers,
  registerMarker,
} from "../src/marker-registry.ts";

beforeEach(() => {
  __resetRegistry();
});

describe("registerMarker", () => {
  it("returns a stable suffix and anchor class for the same (id, modulePath) pair", () => {
    const a = registerMarker("card", "/virtual/markers.ts");
    const b = registerMarker("card", "/virtual/markers.ts");
    expect(a).toBe(b);
    expect(a.suffix).toMatch(/^card_[0-9a-f]{8}$/);
    expect(a.anchorClass).toBe(`bearbones-marker-${a.suffix}`);
  });

  it("produces distinct suffixes for the same id in different module paths", () => {
    const a = registerMarker("card", "/virtual/markers-a.ts");
    const b = registerMarker("card", "/virtual/markers-b.ts");
    expect(a.suffix).not.toBe(b.suffix);
  });

  it("listMarkers returns every registered marker", () => {
    registerMarker("card", "/m.ts");
    registerMarker("row", "/m.ts");
    const ids = listMarkers()
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(["card", "row"]);
  });
});

describe("buildRelationSelector", () => {
  const anchor = "bearbones-marker-card_a27adb16";

  it("ancestor → `<anchor><modifier> &`", () => {
    expect(buildRelationSelector(anchor, ":hover", "ancestor")).toBe(`.${anchor}:hover &`);
  });

  it("descendant → `&:has(<anchor><modifier>)`", () => {
    expect(buildRelationSelector(anchor, "[data-state=open]", "descendant")).toBe(
      `&:has(.${anchor}[data-state=open])`,
    );
  });

  it("sibling → comma-joined `~ &` selectors on both sides", () => {
    expect(buildRelationSelector(anchor, ":focus-within", "sibling")).toBe(
      `& ~ .${anchor}:focus-within, .${anchor}:focus-within ~ &`,
    );
  });

  it("ends in `&` for ancestor / sibling, starts with `&` for descendant — Panda's parseCondition shape", () => {
    expect(buildRelationSelector(anchor, ":hover", "ancestor").endsWith(" &")).toBe(true);
    expect(buildRelationSelector(anchor, ":hover", "descendant").startsWith("&")).toBe(true);
    // sibling has both `~ &` and `& ~` — Panda's `combinator-nesting` branch
    // (`.includes("&")`) handles it.
    expect(buildRelationSelector(anchor, ":hover", "sibling")).toContain("&");
  });
});
