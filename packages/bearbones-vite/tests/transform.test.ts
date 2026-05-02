import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { transform } from "../src/transform.ts";
import { __resetRegistry, listMarkers } from "../src/marker-registry.ts";
import { populateUtilityMapFromTokens } from "../src/utility-map.ts";

// Minimal token tree exercising the same shapes Panda emits. Just enough to
// cover everything the transform tests use (p-4, bg-blue-500, gap, etc.).
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
  __resetRegistry();
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

  it("rewrites marker() declarations to a frozen literal", () => {
    const result = transform({
      filePath: "/virtual/markers.ts",
      source: `
import { marker } from "bearbones";
export const cardMarker = marker("card");
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toContain('anchor: "bearbones-marker-card_');
    expect(result.content).toContain('hover: "_markerHover_card_');
  });

  it("registers markers in the global registry", () => {
    transform({
      filePath: "/virtual/markers.ts",
      source: `
import { marker } from "bearbones";
export const cardMarker = marker("card");
export const rowMarker = marker("row");
      `.trim(),
    });
    const ids = listMarkers().map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["card", "row"]));
  });

  it("rejects dynamic marker ids at build time", () => {
    expect(() =>
      transform({
        filePath: "/virtual/markers.ts",
        source: `
import { marker } from "bearbones";
const name = "card";
export const cardMarker = marker(name);
        `.trim(),
      }),
    ).toThrow(/literal string id/);
  });

  it("resolves a marker imported from another file via cross-file scan", () => {
    // Write a sibling markers file the consumer imports from.
    const dir = mkdtempSync(join(tmpdir(), "bearbones-test-"));
    const markersPath = join(dir, "markers.ts");
    writeFileSync(
      markersPath,
      `import { marker } from "bearbones";
export const cardMarker = marker("card");
`,
    );

    const consumerPath = join(dir, "Card.tsx");
    const result = transform({
      filePath: consumerPath,
      source: `
import { css } from "../styled-system/css";
import { cardMarker } from "./markers.ts";
export const x = css({ [cardMarker.hover]: "bg-blue-500" });
      `.trim(),
    });
    expect(result.content).toBeDefined();
    // The computed key should resolve to the registered condition name.
    expect(result.content).toMatch(/"_markerHover_card_[0-9a-f]{8}":\{"bg":"blue\.500"\}/);
  });

  it("passes through files with no bearbones imports unchanged", () => {
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
});
