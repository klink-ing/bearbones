import { describe, expect, it } from "vitest";
import {
  substituteAmp,
  type EntryNames,
  type InterpolateParts,
  type SubstituteAmp,
} from "../src/index.ts";

describe("substituteAmp", () => {
  it("replaces a single & with the anchor", () => {
    expect(substituteAmp("&:hover", ".target")).toBe(".target:hover");
  });

  it("replaces every & in the input (global replace)", () => {
    expect(substituteAmp(".foo:has(&) ~ &", ".x")).toBe(".foo:has(.x) ~ .x");
  });

  it("returns the input unchanged when no & is present", () => {
    expect(substituteAmp(":hover", ".target")).toBe(":hover");
  });

  it("handles empty input", () => {
    expect(substituteAmp("", ".target")).toBe("");
  });

  it("preserves literal-type precision on its return value", () => {
    const result = substituteAmp("&:hover" as const, ".target" as const);
    // The compile-time type pins the substituted literal — if the recursive
    // type widens, the assignment fails.
    const literal: ".target:hover" = result;
    expect(literal).toBe(".target:hover");
  });
});

describe("type-level utilities", () => {
  it("InterpolateParts joins segments with the interpolated value", () => {
    type AncestorTemplate = InterpolateParts<[":where(", ") &"], ".x:hover">;
    const expected: AncestorTemplate = ":where(.x:hover) &";
    expect(expected).toBe(":where(.x:hover) &");
  });

  it("InterpolateParts handles three-segment templates (siblingAny shape)", () => {
    type AnyTemplate = InterpolateParts<["&:where(:has(~ ", ")), :where(", ") ~ &"], ".x:hover">;
    const expected: AnyTemplate = "&:where(:has(~ .x:hover)), :where(.x:hover) ~ &";
    expect(expected).toBe("&:where(:has(~ .x:hover)), :where(.x:hover) ~ &");
  });

  it("InterpolateParts collapses to the only segment when there's no interpolation point", () => {
    type Single = InterpolateParts<["just-text"], "ignored">;
    const expected: Single = "just-text";
    expect(expected).toBe("just-text");
  });

  it("EntryNames extracts the name from each [name, ...] tuple in declaration order", () => {
    const entries = [
      ["ancestor", [":where(", ") &"]],
      ["descendant", ["&:where(:has(", "))"]],
    ] as const;
    type Names = EntryNames<typeof entries>;
    const expected: Names = ["ancestor", "descendant"];
    expect(expected).toEqual(["ancestor", "descendant"]);
  });

  it("SubstituteAmp produces the same literal as the runtime helper", () => {
    type Result = SubstituteAmp<"&:has(.foo)", ".m">;
    const expected: Result = ".m:has(.foo)";
    expect(expected).toBe(substituteAmp("&:has(.foo)", ".m"));
  });
});
