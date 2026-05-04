import { describe, it, expect, beforeEach } from "vitest";
import { transform } from "../src/transform.ts";
import { populateUtilityMapFromTokens } from "../src/utility-map.ts";

// Minimal token tree exercising the same shapes Panda emits — just enough
// to cover everything the transform tests use (p-4, bg-blue-500, gap, etc.).
// Production runs populate this from `config.theme.tokens` at config:resolved.
const MOCK_TOKENS = {
  spacing: {
    "0": { value: "0" },
    "4": { value: "1rem" },
    "8": { value: "2rem" },
  },
  colors: {
    blue: {
      "500": { value: "#3b82f6" },
      "800": { value: "#1e40af" },
    },
    white: { value: "#fff" },
  },
  fontSizes: {},
  fontWeights: {},
  radii: {},
  shadows: {},
};

beforeEach(() => {
  populateUtilityMapFromTokens(MOCK_TOKENS);
});

describe("transform", () => {
  it("lowers a single utility string in a css() call", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css } from "../styled-system/css";
export const x = css("p-4");
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toContain('css({"p":"4"})');
  });

  it("lowers multiple utility strings as separate args (preserving merge order)", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css } from "../styled-system/css";
export const x = css("p-4", "bg-blue-500");
      `.trim(),
    });
    expect(result.content).toContain('css({"p":"4"}, {"bg":"blue.500"})');
  });

  it("lowers utility strings inside a condition object value", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css } from "../styled-system/css";
export const x = css("p-4", { _hover: "bg-blue-500" });
      `.trim(),
    });
    expect(result.content).toContain('"_hover":{"bg":"blue.500"}');
  });

  it("lowers an array of utility strings under a condition (last wins)", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css } from "../styled-system/css";
export const x = css({ _hover: ["bg-blue-500", "text-white"] });
      `.trim(),
    });
    expect(result.content).toContain('"_hover":{"bg":"blue.500","color":"white"}');
  });

  it("passes through files with no styled-system imports unchanged", () => {
    const source = "export const x = 1;";
    const result = transform({
      filePath: "/virtual/plain.ts",
      source,
    });
    expect(result.content).toBeUndefined();
  });

  it("recognizes css imports from styled-system paths", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css } from "../../styled-system/css";
export const x = css("flex");
      `.trim(),
    });
    expect(result.content).toContain('css({"display":"flex"})');
  });

  it("leaves marker imports alone (handled by @klinking/panda-markers)", () => {
    // The shorthand transform must not throw or rewrite anything when the
    // file uses marker() — that's the markers plugin's domain.
    const source = `
import { marker } from "../styled-system/css";
export const cardMarker = marker("card");
    `.trim();
    const result = transform({
      filePath: "/virtual/markers.ts",
      source,
    });
    expect(result.content).toBeUndefined();
  });

  it("does not rewrite computed-key relational chains (markers' job)", () => {
    // The markers plugin handles these. With shorthand alone, the css()
    // call has a computed key that shorthand can't resolve, so it bails out
    // and leaves the source unchanged.
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css, marker } from "../styled-system/css";
const m = marker("g");
export const x = css({ [m("&:focus-within").is.siblingBefore]: "p-4" });
      `.trim(),
    });
    expect(result.content).toBeUndefined();
  });
});
