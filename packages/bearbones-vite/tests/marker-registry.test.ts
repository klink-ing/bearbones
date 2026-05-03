import Specificity from "@bramus/specificity";
import { describe, it, expect } from "vitest";
import {
  MARKER_RELATIONS,
  buildRelationSelector,
  composeRelationSelectors,
  describeMarker,
} from "../src/marker-registry.ts";

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
  const M = `.${anchor}:hover`;

  it("ancestor → `:where(M) &` after & substitution", () => {
    expect(buildRelationSelector(anchor, "&:hover", "ancestor")).toBe(`:where(${M}) &`);
  });

  it("descendant → `&:where(:has(M))` after & substitution", () => {
    expect(buildRelationSelector(anchor, "[data-state=open] &", "descendant")).toBe(
      `&:where(:has([data-state=open] .${anchor}))`,
    );
  });

  it("siblingBefore → `:where(M) ~ &` after & substitution", () => {
    expect(buildRelationSelector(anchor, "&:focus-within", "siblingBefore")).toBe(
      `:where(.${anchor}:focus-within) ~ &`,
    );
  });

  it("siblingAfter → `&:where(:has(~ M))` after & substitution", () => {
    expect(buildRelationSelector(anchor, "&:focus-within", "siblingAfter")).toBe(
      `&:where(:has(~ .${anchor}:focus-within))`,
    );
  });

  it("siblingAny → `&:where(:has(~ M)), :where(M) ~ &` (`&`-prefixed branch first for AnySelector)", () => {
    expect(buildRelationSelector(anchor, "&:focus-within", "siblingAny")).toBe(
      `&:where(:has(~ .${anchor}:focus-within)), :where(.${anchor}:focus-within) ~ &`,
    );
  });

  it("substitutes every & in the input (global replace)", () => {
    expect(buildRelationSelector(anchor, ".foo:has(&) ~ &", "ancestor")).toBe(
      `:where(.foo:has(.${anchor}) ~ .${anchor}) &`,
    );
  });

  it("Panda nesting compatibility — every relation parses as a nesting selector", () => {
    // Mirrors `@pandacss/core` `parseCondition`: startsWith("&") = self-nesting,
    // endsWith(" &") = parent-nesting, includes("&") = combinator-nesting.
    const cases: Record<string, "self" | "parent" | "combinator"> = {
      ancestor: "parent",
      descendant: "self",
      siblingBefore: "parent",
      siblingAfter: "self",
      // siblingAny is comma-joined; the `&`-prefixed branch first satisfies
      // `startsWith("&")` so Panda routes the whole rule through self-nesting.
      // Both halves substitute `&` correctly via postcss-nested.
      siblingAny: "self",
    };
    for (const [relation, expected] of Object.entries(cases)) {
      const sel = buildRelationSelector(
        anchor,
        "&:hover",
        relation as (typeof MARKER_RELATIONS)[number],
      );
      const actual = sel.startsWith("&")
        ? "self"
        : sel.endsWith(" &")
          ? "parent"
          : sel.includes("&")
            ? "combinator"
            : "none";
      expect(actual, `${relation}: ${sel}`).toBe(expected);
    }
  });

  it("throws when the condition value lacks the & placeholder", () => {
    expect(() => buildRelationSelector(anchor, ":hover", "ancestor")).toThrow(/'&' placeholder/);
  });

  // Specificity contract: every marker rule emits at (0,1,0) — same as a
  // plain utility class. The `:where(...)` wrap collapses the marker side to
  // zero specificity; only the styled element's own class (substituted in
  // for the trailing `&` by Panda's `postcss-nested` at emit time) counts.
  // This mirrors StyleX's `when.*` API contract.
  describe("specificity contract — every relation reports (0,1,0)", () => {
    for (const relation of MARKER_RELATIONS) {
      it(`${relation} → (0,1,0) per comma-branch`, () => {
        const sel = buildRelationSelector(anchor, "&:hover", relation);
        // Substitute Panda's `&` placeholder for a sentinel class to produce
        // a real CSS selector (mimics what `postcss-nested` does at emit
        // time). Use a global replace so multi-`&` shapes (siblingAny) are
        // fully resolved.
        const real = sel.replaceAll("&", ".target");
        const branches = Specificity.calculate(real);
        expect(
          branches.length,
          `${relation}: parsed ${branches.length} branches from ${real}`,
        ).toBeGreaterThanOrEqual(1);
        for (const branch of branches) {
          expect(branch.toArray(), `${relation} branch ${branch.selectorString()}`).toEqual([
            0, 1, 0,
          ]);
        }
      });
    }
  });
});

describe("composeRelationSelectors", () => {
  it("preserves the literal selector shape for each relation", () => {
    const selectors = composeRelationSelectors(".bearbones-marker-card_a27adb16:hover" as const);
    const expected: {
      ancestor: ":where(.bearbones-marker-card_a27adb16:hover) &";
      descendant: "&:where(:has(.bearbones-marker-card_a27adb16:hover))";
      siblingBefore: ":where(.bearbones-marker-card_a27adb16:hover) ~ &";
      siblingAfter: "&:where(:has(~ .bearbones-marker-card_a27adb16:hover))";
      siblingAny: "&:where(:has(~ .bearbones-marker-card_a27adb16:hover)), :where(.bearbones-marker-card_a27adb16:hover) ~ &";
    } = selectors;
    const roundTrip: typeof selectors = expected;

    expect(roundTrip).toEqual({
      ancestor: ":where(.bearbones-marker-card_a27adb16:hover) &",
      descendant: "&:where(:has(.bearbones-marker-card_a27adb16:hover))",
      siblingBefore: ":where(.bearbones-marker-card_a27adb16:hover) ~ &",
      siblingAfter: "&:where(:has(~ .bearbones-marker-card_a27adb16:hover))",
      siblingAny:
        "&:where(:has(~ .bearbones-marker-card_a27adb16:hover)), :where(.bearbones-marker-card_a27adb16:hover) ~ &",
    });
  });
});

describe("MARKER_RELATIONS", () => {
  it("is a precise tuple of the RELATION_SELECTORS keys in declared order", () => {
    const expected: readonly [
      "ancestor",
      "descendant",
      "siblingBefore",
      "siblingAfter",
      "siblingAny",
    ] = MARKER_RELATIONS;
    const roundTrip: typeof MARKER_RELATIONS = expected;

    expect(roundTrip).toEqual([
      "ancestor",
      "descendant",
      "siblingBefore",
      "siblingAfter",
      "siblingAny",
    ]);
  });
});
