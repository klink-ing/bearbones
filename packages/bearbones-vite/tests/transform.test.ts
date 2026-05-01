import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { transform } from "../src/transform.ts";
import { __resetRegistry, listGroups } from "../src/group-registry.ts";

beforeEach(() => {
  __resetRegistry();
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

  it("rewrites group() declarations to a frozen literal", () => {
    const result = transform({
      filePath: "/virtual/groups.ts",
      source: `
import { group } from "bearbones";
export const cardGroup = group("card");
      `.trim(),
    });
    expect(result.content).toBeDefined();
    expect(result.content).toContain('anchor: "bearbones-group-card_');
    expect(result.content).toContain('hover: "_groupHover_card_');
  });

  it("registers groups in the global registry", () => {
    transform({
      filePath: "/virtual/groups.ts",
      source: `
import { group } from "bearbones";
export const cardGroup = group("card");
export const rowGroup = group("row");
      `.trim(),
    });
    const ids = listGroups().map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(["card", "row"]));
  });

  it("rejects dynamic group ids at build time", () => {
    expect(() =>
      transform({
        filePath: "/virtual/groups.ts",
        source: `
import { group } from "bearbones";
const name = "card";
export const cardGroup = group(name);
        `.trim(),
      }),
    ).toThrow(/literal string id/);
  });

  it("resolves a group imported from another file via cross-file scan", () => {
    // Write a sibling groups file the consumer imports from.
    const dir = mkdtempSync(join(tmpdir(), "bearbones-test-"));
    const groupsPath = join(dir, "groups.ts");
    writeFileSync(
      groupsPath,
      `import { group } from "bearbones";
export const cardGroup = group("card");
`,
    );

    const consumerPath = join(dir, "Card.tsx");
    const result = transform({
      filePath: consumerPath,
      source: `
import { css } from "../styled-system/css";
import { cardGroup } from "./groups.ts";
export const x = css({ [cardGroup.hover]: "bg-blue-500" });
      `.trim(),
    });
    expect(result.content).toBeDefined();
    // The computed key should resolve to the registered condition name.
    expect(result.content).toMatch(/"_groupHover_card_[0-9a-f]{8}":\{"bg":"blue\.500"\}/);
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
