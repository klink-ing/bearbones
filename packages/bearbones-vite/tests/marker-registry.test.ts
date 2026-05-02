import { describe, it, expect } from "vitest";
import { buildRelationSelector, describeMarker } from "../src/marker-registry.ts";

describe("describeMarker", () => {
  it("derives a stable suffix and anchor class from `(id, modulePath)`", () => {
    const a = describeMarker("card", "/virtual/markers.ts");
    expect(a.suffix).toMatch(/^card_[0-9a-f]{8}$/);
    expect(a.anchorClass).toBe(`bearbones-marker-${a.suffix}`);
  });

  it("is deterministic — same inputs produce the same descriptor", () => {
    const a = describeMarker("card", "/virtual/markers.ts");
    const b = describeMarker("card", "/virtual/markers.ts");
    expect(a.suffix).toBe(b.suffix);
    expect(a.anchorClass).toBe(b.anchorClass);
  });

  it("produces distinct suffixes for the same id in different module paths", () => {
    const a = describeMarker("card", "/virtual/markers-a.ts");
    const b = describeMarker("card", "/virtual/markers-b.ts");
    expect(a.suffix).not.toBe(b.suffix);
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

  it("sibling → `& ~ <anchor><modifier>, <anchor><modifier> ~ &`", () => {
    expect(buildRelationSelector(anchor, ":focus-within", "sibling")).toBe(
      `& ~ .${anchor}:focus-within, .${anchor}:focus-within ~ &`,
    );
  });

  it("ends in `&` for ancestor, starts with `&` for descendant + sibling — matches Panda's AnySelector", () => {
    expect(buildRelationSelector(anchor, ":hover", "ancestor").endsWith(" &")).toBe(true);
    expect(buildRelationSelector(anchor, ":hover", "descendant").startsWith("&")).toBe(true);
    expect(buildRelationSelector(anchor, ":hover", "sibling").startsWith("&")).toBe(true);
  });
});
