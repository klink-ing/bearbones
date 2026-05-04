import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { transform } from "../src/transform.ts";

describe("transform — marker declarations", () => {
  it("rewrites marker() declarations to a callable record", () => {
    const result = transform({
      filePath: "/virtual/markers.ts",
      source: `
import { marker } from "../styled-system/css";
export const cardMarker = marker("card");
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toContain('anchor: "bearbones-marker-card_');
    expect(result.content).toMatch(
      /_hover: \{ is: \{ ancestor: ":where\(\.bearbones-marker-card_[0-9a-f]{8}:is\(:hover, \[data-hover\]\)\) &"/,
    );
  });

  it("rewrites both markers in a multi-marker file with deterministic suffixes", () => {
    const result = transform({
      filePath: "/virtual/markers.ts",
      source: `
import { marker } from "../styled-system/css";
export const cardMarker = marker("card");
export const rowMarker = marker("row");
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toMatch(/anchor: "bearbones-marker-card_[0-9a-f]{8}"/);
    expect(result.content).toMatch(/anchor: "bearbones-marker-row_[0-9a-f]{8}"/);
  });

  it("rejects dynamic marker ids at build time", () => {
    expect(() =>
      transform({
        filePath: "/virtual/markers.ts",
        source: `
import { marker } from "../styled-system/css";
const name = "card";
export const cardMarker = marker(name);
        `.trim(),
      }),
    ).toThrow(/literal string id/);
  });

  it("resolves a marker imported from another file via cross-file scan", () => {
    const dir = mkdtempSync(join(tmpdir(), "klinking-markers-test-"));
    const markersPath = join(dir, "markers.ts");
    writeFileSync(
      markersPath,
      `import { marker } from "../styled-system/css";
export const cardMarker = marker("card");
`,
    );

    const consumerPath = join(dir, "Card.tsx");
    const result = transform({
      filePath: consumerPath,
      source: `
import { css } from "../styled-system/css";
import { cardMarker } from "./markers.ts";
export const x = css({ [cardMarker._hover.is.ancestor]: { padding: "4" } });
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toMatch(
      /":where\(\.bearbones-marker-card_[0-9a-f]{8}:is\(:hover, \[data-hover\]\)\) &": \{ padding: "4" \}/,
    );
  });

  it("passes through files with no styled-system imports unchanged", () => {
    const result = transform({
      filePath: "/virtual/plain.ts",
      source: "export const x = 1;",
    });
    expect(result.content).toBeUndefined();
  });

  it("synthesizes a callable marker record with the relations helper", () => {
    const result = transform({
      filePath: "/virtual/markers.ts",
      source: `
import { marker } from "../styled-system/css";
export const cardMarker = marker("card");
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toContain("__bearbones_relations");
    expect(result.content).toMatch(
      /Object\.assign\(\(c\) => __bearbones_relations\(c, "bearbones-marker-card_/,
    );
    expect(result.content).toMatch(
      /_hover: \{ is: \{ ancestor: ":where\(\.bearbones-marker-card_[0-9a-f]{8}:is\(:hover, \[data-hover\]\)\) &"/,
    );
  });
});

describe("transform — relational marker chains", () => {
  it("lowers marker('&:has(.error)').is.ancestor to a `:where(M) &` raw selector key", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css, marker } from "../styled-system/css";
const m = marker("container");
export const x = css({ [m("&:has(.error)").is.ancestor]: { padding: "4" } });
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toMatch(
      /":where\(\.bearbones-marker-container_[0-9a-f]{8}:has\(\.error\)\) &": \{ padding: "4" \}/,
    );
  });

  it("lowers marker._<name>.is.descendant to a `&:where(:has(M))` raw selector key", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css, marker } from "../styled-system/css";
const m = marker("panel");
export const x = css({ [m._focusVisible.is.descendant]: { padding: "4" } });
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toMatch(
      /"&:where\(:has\(\.bearbones-marker-panel_[0-9a-f]{8}:is\(:focus-visible, \[data-focus-visible\]\)\)\)": \{ padding: "4" \}/,
    );
  });

  it("lowers .is.siblingBefore to a `:where(M) ~ &` raw selector key", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css, marker } from "../styled-system/css";
const m = marker("g");
export const x = css({ [m("&:focus-within").is.siblingBefore]: { padding: "4" } });
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toMatch(
      /":where\(\.bearbones-marker-g_[0-9a-f]{8}:focus-within\) ~ &": \{ padding: "4" \}/,
    );
  });

  it("lowers .is.siblingAfter to a `&:where(:has(~ M))` raw selector key", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css, marker } from "../styled-system/css";
const m = marker("g");
export const x = css({ [m("&:focus-within").is.siblingAfter]: { padding: "4" } });
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toMatch(
      /"&:where\(:has\(~ \.bearbones-marker-g_[0-9a-f]{8}:focus-within\)\)": \{ padding: "4" \}/,
    );
  });

  it("lowers .is.siblingAny to the comma-joined `&:where(:has(~ M)), :where(M) ~ &` form", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css, marker } from "../styled-system/css";
const m = marker("group");
export const x = css({ [m("&:focus-within").is.siblingAny]: { padding: "4" } });
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toMatch(
      /"&:where\(:has\(~ \.bearbones-marker-group_[0-9a-f]{8}:focus-within\)\), :where\(\.bearbones-marker-group_[0-9a-f]{8}:focus-within\) ~ &": \{ padding: "4" \}/,
    );
  });

  it("derives the same anchor suffix for a marker used in declaration + chain in one file", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css, marker } from "../styled-system/css";
const widgetMarker = marker("widget");
export const x = css({
  [widgetMarker("&:has(.error)").is.ancestor]: { padding: "4" },
});
      `.trim(),
    });
    expect(result.content).toBeDefined();
    const anchorMatch = result.content!.match(/anchor: "bearbones-marker-widget_([0-9a-f]{8})"/);
    expect(anchorMatch).not.toBeNull();
    const suffix = anchorMatch![1];
    expect(result.content).toContain(
      `":where(.bearbones-marker-widget_${suffix}:has(.error)) &": { padding: "4" }`,
    );
  });

  it("substitutes every & in the condition value (parent-nesting form)", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css, marker } from "../styled-system/css";
const m = marker("card");
export const x = css({ [m("[data-state=open] &").is.descendant]: { padding: "4" } });
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toMatch(
      /"&:where\(:has\(\[data-state=open\] \.bearbones-marker-card_[0-9a-f]{8}\)\)": \{ padding: "4" \}/,
    );
  });

  it("substitutes multiple & occurrences in a single condition value", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css, marker } from "../styled-system/css";
const m = marker("card");
export const x = css({ [m(".foo:has(&) ~ &").is.siblingAny]: { padding: "4" } });
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toMatch(
      /\.foo:has\(\.bearbones-marker-card_[0-9a-f]{8}\) ~ \.bearbones-marker-card_[0-9a-f]{8}/,
    );
  });

  it("rejects a call-form condition value missing the & placeholder", () => {
    expect(() =>
      transform({
        filePath: "/virtual/file.tsx",
        source: `
import { css, marker } from "../styled-system/css";
const m = marker("noamp");
export const x = css({ [m(":hover").is.ancestor]: { padding: "4" } });
        `.trim(),
      }),
    ).toThrow(/'&' placeholder/);
  });

  it("leaves the chain untouched when condition value is dynamic", () => {
    const result = transform({
      filePath: "/virtual/file.tsx",
      source: `
import { css, marker } from "../styled-system/css";
const m = marker("dyn");
const sel = "&:hover";
export const x = css({ [m(sel).is.ancestor]: { padding: "4" } });
      `.trim(),
    });
    // The relational key resolver returns null for the dynamic chain. The
    // marker declaration still gets rewritten (so result.content is non-
    // empty), but the css() argument's computed key stays as authored.
    expect(result.content).toBeDefined();
    expect(result.content).toContain("[m(sel).is.ancestor]");
  });
});
