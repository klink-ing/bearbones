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

  it("rewrites marker() declarations to a callable record", () => {
    const result = transform({
      filePath: "/virtual/markers.ts",
      source: `
import { marker } from "bearbones";
export const cardMarker = marker("card");
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toContain('anchor: "bearbones-marker-card_');
    expect(result.content).toMatch(
      /_hover: \{ is: \{ ancestor: "\.bearbones-marker-card_[0-9a-f]{8}:is\(:hover, \[data-hover\]\) &"/,
    );
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
export const x = css({ [cardMarker._hover.is.ancestor]: "bg-blue-500" });
      `.trim(),
    });
    expect(result.content).toBeDefined();
    // The computed key should resolve to the composed raw selector.
    expect(result.content).toMatch(
      /"\.bearbones-marker-card_[0-9a-f]{8}:is\(:hover, \[data-hover\]\) &":\{"bg":"blue\.500"\}/,
    );
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

describe("transform — relational marker chains", () => {
  it("synthesizes a callable marker record with the relations helper", () => {
    const result = transform({
      filePath: "/virtual/markers.ts",
      source: `
import { marker } from "bearbones";
export const cardMarker = marker("card");
      `.trim(),
    });
    expect(result.content).toBeDefined();
    // Helper is prepended once per file.
    expect(result.content).toContain("__bearbones_relations");
    // Synthesized record uses Object.assign to wrap the call form + the
    // typed `_<state>` builder properties. Function half delegates to the
    // helper with the marker's anchor class.
    expect(result.content).toMatch(
      /Object\.assign\(\(m\) => __bearbones_relations\(m, "bearbones-marker-card_/,
    );
    // Underscore builder forms are emitted with literal raw-selector strings.
    expect(result.content).toMatch(
      /_hover: \{ is: \{ ancestor: "\.bearbones-marker-card_[0-9a-f]{8}:is\(:hover, \[data-hover\]\) &"/,
    );
    // No legacy condition-name string lurking on the record.
    expect(result.content).not.toMatch(/hover: "_markerHover_card_/);
    expect(result.content).not.toMatch(/_marker_card_[0-9a-f]{8}_ancestor_/);
  });

  it("lowers marker(LITERAL).is.ancestor to a raw selector key", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css } from "../styled-system/css";
import { marker } from "bearbones";
const m = marker("container");
export const x = css({ [m(":has(.error)").is.ancestor]: "p-4" });
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toMatch(
      /"\.bearbones-marker-container_[0-9a-f]{8}:has\(\.error\) &":\{"p":"4"\}/,
    );
  });

  it("lowers marker._<state>.is.descendant to a `&:has(...)` raw selector key", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css } from "../styled-system/css";
import { marker } from "bearbones";
const m = marker("panel");
export const x = css({ [m._focusVisible.is.descendant]: "p-4" });
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toMatch(
      /"&:has\(\.bearbones-marker-panel_[0-9a-f]{8}:focus-visible\)":\{"p":"4"\}/,
    );
  });

  it("lowers .is.sibling to the comma-joined raw selector form", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css } from "../styled-system/css";
import { marker } from "bearbones";
const m = marker("group");
export const x = css({ [m(":focus-within").is.sibling]: "p-4" });
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toMatch(
      /"& ~ \.bearbones-marker-group_[0-9a-f]{8}:focus-within, \.bearbones-marker-group_[0-9a-f]{8}:focus-within ~ &":\{"p":"4"\}/,
    );
  });

  it("registers each marker referenced in a chain so listMarkers includes it", () => {
    transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css } from "../styled-system/css";
import { marker } from "bearbones";
const widgetMarker = marker("widget");
export const x = css({
  [widgetMarker(":has(.error)").is.ancestor]: "p-4",
});
      `.trim(),
    });
    const widget = listMarkers().find((mk) => mk.id === "widget");
    expect(widget).toBeDefined();
    expect(widget!.anchorClass).toMatch(/^bearbones-marker-widget_[0-9a-f]{8}$/);
  });

  it("leaves the chain untouched when modifier is dynamic", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css } from "../styled-system/css";
import { marker } from "bearbones";
const m = marker("dyn");
const sel = ":hover";
export const x = css({ [m(sel).is.ancestor]: "p-4" });
      `.trim(),
    });
    // The css() argument can't be lowered (computed key resolves to null),
    // so the entire object stays as authored.
    expect(result.content).toBeDefined();
    expect(result.content).toContain("[m(sel).is.ancestor]");
  });
});
