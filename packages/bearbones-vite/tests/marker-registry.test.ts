import { beforeEach, describe, it, expect } from "vitest";
import {
  __resetRegistry,
  buildMarkerConditions,
  buildRelationConditionName,
  buildRelationSelector,
  modifierHash,
  registerMarker,
  registerMarkerCondition,
} from "../src/marker-registry.ts";

beforeEach(() => {
  __resetRegistry();
});

describe("modifierHash", () => {
  it("is deterministic for the same input", () => {
    expect(modifierHash(":hover")).toBe(modifierHash(":hover"));
    expect(modifierHash(":has(.error)")).toBe(modifierHash(":has(.error)"));
  });

  it("produces different hashes for different inputs", () => {
    expect(modifierHash(":hover")).not.toBe(modifierHash(":focus"));
    expect(modifierHash(":has(.foo)")).not.toBe(modifierHash(":has(.bar)"));
  });

  it("produces 8 hex chars", () => {
    expect(modifierHash(":hover")).toMatch(/^[0-9a-f]{8}$/);
    expect(modifierHash("")).toMatch(/^[0-9a-f]{8}$/);
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
      `.${anchor}:focus-within ~ &, & ~ .${anchor}:focus-within`,
    );
  });
});

describe("registerMarkerCondition", () => {
  it("registers a (modifier, relation) pair on the marker", () => {
    const m = registerMarker("card", "/virtual/markers.ts");
    const { conditionName } = registerMarkerCondition(
      "card",
      "/virtual/markers.ts",
      ":has(.error)",
      "ancestor",
    );
    expect(conditionName).toBe(buildRelationConditionName(m.suffix, "ancestor", ":has(.error)"));
    expect(m.relations.has(conditionName)).toBe(true);
    expect(m.relations.get(conditionName)?.modifier).toBe(":has(.error)");
  });

  it("is idempotent: same inputs collapse to the same condition entry", () => {
    const a = registerMarkerCondition("x", "/m.ts", ":hover", "ancestor");
    const b = registerMarkerCondition("x", "/m.ts", ":hover", "ancestor");
    expect(a.conditionName).toBe(b.conditionName);
  });

  it("includes registered relations in buildMarkerConditions output", () => {
    registerMarkerCondition("x", "/m.ts", ":has(.error)", "ancestor");
    registerMarkerCondition("x", "/m.ts", ":focus-within", "sibling");
    const conditions = buildMarkerConditions();
    const ancestorKey = buildRelationConditionName(
      "x_" + modifierKnownHash(),
      "ancestor",
      ":has(.error)",
    );
    // We don't know the marker suffix's hash without recomputing it, so just
    // assert the shape: at least one ancestor key and one sibling key exist.
    const ancestorKeys = Object.keys(conditions).filter((k) => /_ancestor_/.test(k));
    const siblingKeys = Object.keys(conditions).filter((k) => /_sibling_/.test(k));
    expect(ancestorKeys.length).toBeGreaterThan(0);
    expect(siblingKeys.length).toBeGreaterThan(0);
    // Selectors include the modifier verbatim.
    const ancestorSelector = conditions[ancestorKeys[0]!];
    expect(ancestorSelector).toMatch(/:has\(\.error\) &$/);
    const siblingSelector = conditions[siblingKeys[0]!];
    expect(siblingSelector).toContain(":focus-within ~ &");
    void ancestorKey; // suppress unused
  });

  it("does not emit legacy `markerHover_<suffix>` shortcut conditions anymore", () => {
    registerMarkerCondition("x", "/m.ts", ":has(.error)", "ancestor");
    const conditions = buildMarkerConditions();
    const legacy = Object.keys(conditions).filter((k) => /^marker(Hover|Focus|Active)_/.test(k));
    expect(legacy).toEqual([]);
  });
});

function modifierKnownHash(): string {
  // Placeholder used by one of the assertions above where we don't need the
  // exact suffix hash. Kept as a function so the test reads naturally.
  return "00000000";
}
