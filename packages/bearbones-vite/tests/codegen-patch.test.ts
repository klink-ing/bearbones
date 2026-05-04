import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  patchCssArtifact,
  patchCssRuntime,
  patchArtifacts,
  type PandaArtifact,
} from "../src/codegen-patch.ts";
import { loadTemplate } from "../src/codegen-templates.ts";

// Fixture is named `.d.ts.txt` (not `.d.ts`) so oxfmt and tsc skip it.
// We need Panda's *exact* emitted bytes — including its single-quote import
// style and missing trailing semicolons — to assert that our AST-based
// splice locator handles the real shape Panda emits. Letting the repo
// formatter rewrite this file would silently move us off that ground truth.
const FIXTURE_PATH = join(__dirname, "fixtures", "panda-css.d.ts.txt");
const FIXTURE_SOURCE = readFileSync(FIXTURE_PATH, "utf8");

const SAMPLE_UTILITIES = ["p-4", "bg-blue-500", "flex"] as const;
const SAMPLE_CONDITIONS = [
  { name: "hover", value: "&:is(:hover, [data-hover])" },
  { name: "focus", value: "&:is(:focus, [data-focus])" },
  { name: "focusVisible", value: "&:is(:focus-visible, [data-focus-visible])" },
  { name: "dark", value: ".dark &" },
] as const;

// oxfmt's stdin mode walks up from cwd looking for a config file. Pin it to
// this package's dir so the same `.oxfmtrc` rules the rest of the repo uses
// also apply to the test-time normalization.
const PKG_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const OXFMT_BIN = join(PKG_DIR, "..", "..", "node_modules", ".bin", "oxfmt");

/**
 * Normalize TypeScript source through oxfmt so assertions and snapshots
 * don't pin specific whitespace, quote style, or line-break placement.
 * The renderer's static templates are written in their natural editor
 * format; the patched output's exact whitespace is incidental.
 */
function format(source: string, filename = "css.d.ts"): string {
  return execFileSync(OXFMT_BIN, [`--stdin-filepath=${filename}`], {
    input: source,
    cwd: PKG_DIR,
    encoding: "utf8",
  });
}

describe("patchCssArtifact", () => {
  it("injects BearbonesUtilityName, BearbonesNested, BearbonesSystemStyleObject", () => {
    const patched = format(patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS));
    expect(patched).toContain("export type BearbonesUtilityName =");
    expect(patched).toContain("export type BearbonesNested<P>");
    expect(patched).toContain("export type BearbonesSystemStyleObject");
  });

  it("injects BearbonesMarker / BearbonesMarkerBuilder / marker declaration", () => {
    const patched = format(patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS));
    expect(patched).toContain("export interface BearbonesMarkerBuilder");
    expect(patched).toContain("export interface BearbonesMarker");
    expect(patched).toContain("export declare function marker<Id extends string>(id: Id)");
  });

  it("enumerates the host's condition vocabulary in a single BearbonesMarkerConditions map", () => {
    const patched = format(patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS));
    expect(patched).toContain("type BearbonesMarkerConditions = {");
    for (const { name, value } of SAMPLE_CONDITIONS) {
      // oxfmt strips quotes from keys that are valid TS identifiers, so
      // `readonly "hover"` becomes `readonly hover`. Accept either form.
      const quoted = `readonly ${JSON.stringify(name)}: ${JSON.stringify(value)};`;
      const bare = `readonly ${name}: ${JSON.stringify(value)};`;
      expect(
        patched.includes(quoted) || patched.includes(bare),
        `expected condition ${name} to appear as a typed map entry`,
      ).toBe(true);
    }
    // The CSS condition strings should NOT be duplicated on per-shortcut
    // lines; they live exactly once in the BearbonesMarkerConditions map.
    for (const { value } of SAMPLE_CONDITIONS) {
      const occurrences = patched.split(JSON.stringify(value)).length - 1;
      expect(occurrences, `condition ${JSON.stringify(value)} appears ${occurrences} times`).toBe(
        1,
      );
    }
  });

  it("derives _<name> shortcuts via mapped type over BearbonesMarkerConditions", () => {
    const patched = format(patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS));
    expect(patched).toContain("type BearbonesMarkerShortcuts<Id extends string> = {");
    expect(patched).toContain(
      "readonly [K in keyof BearbonesMarkerConditions as `_${K & string}`]",
    );
    expect(patched).toContain("BearbonesMarkerBuilder<");
    expect(patched).toContain("BearbonesMarkerConditions[K]");
    expect(patched).toContain("export interface BearbonesMarker<Id extends string = string>");
    expect(patched).toContain("extends BearbonesMarkerShortcuts<Id> {");
  });

  it("derives relation types from runtime function return types via ReturnType<typeof ...>", () => {
    const patched = format(patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS));
    // The marker observer + relation shape are derived from the return
    // types of `markerAnchor`, `substituteAmp`, and `composeRelationSelectors`
    // in `@bearbones/vite/marker-registry` — single source of truth, no
    // hand-maintained duplicate of the selector shapes in the type emit.
    expect(patched).toContain("import type {");
    expect(patched).toContain("composeRelationSelectors,");
    expect(patched).toContain("markerAnchor,");
    expect(patched).toContain("markerAnchorClass,");
    expect(patched).toContain("substituteAmp,");
    expect(patched).toContain('} from "@bearbones/vite";');
    expect(patched).toContain("readonly anchor: ReturnType<typeof markerAnchorClass<Id, string>>;");
    expect(patched).toContain('typeof markerAnchor<Id, "<HASH>">');
    expect(patched).toContain("typeof substituteAmp<Cond, BearbonesMarkerAnchor<Id>>");
    expect(patched).toContain(
      "readonly is: ReturnType<typeof composeRelationSelectors<BearbonesObserver<Id, Cond>>>;",
    );
  });

  it("emits a generic call form so literal condValue args produce concrete chain types", () => {
    const patched = format(patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS));
    expect(patched).toContain("<C extends string>(condValue: C): BearbonesMarkerBuilder<Id, C>");
  });

  it("includes every utility name passed in as a quoted union member", () => {
    const patched = format(patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS));
    for (const name of SAMPLE_UTILITIES) {
      expect(patched).toContain(`"${name}"`);
    }
  });

  it("emits `never` when no utilities are passed", () => {
    const patched = format(patchCssArtifact(FIXTURE_SOURCE, [], SAMPLE_CONDITIONS));
    // After oxfmt normalization the union collapses to a single line.
    expect(patched).toContain("export type BearbonesUtilityName = never;");
  });

  it("rewrites the Styles type alias to point at BearbonesSystemStyleObject", () => {
    const patched = format(patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS));
    expect(patched).toContain(
      "type Styles = BearbonesSystemStyleObject | undefined | null | false",
    );
    // The original Panda alias must be gone — otherwise both definitions would
    // collide and the patch would silently fail at type-check time.
    expect(patched).not.toContain("type Styles = SystemStyleObject | undefined | null | false");
  });

  it("imports the Panda helper types it references", () => {
    const patched = format(patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS));
    expect(patched).toContain('import type { Nested, Conditions } from "../types/conditions";');
    expect(patched).toContain('import type { Selectors, AnySelector } from "../types/selectors";');
    expect(patched).toContain(
      'import type { SystemProperties, CssVarProperties } from "../types/style-props";',
    );
  });

  it("preserves the rest of Panda's emitted file (CssFunction, css const)", () => {
    const patched = format(patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS));
    expect(patched).toContain("interface CssFunction");
    expect(patched).toContain("export declare const css: CssFunction;");
    expect(patched).toContain("interface CssRawFunction");
  });

  it("throws a self-diagnosing error when the Styles type alias is missing", () => {
    const broken = FIXTURE_SOURCE.replace(/type Styles = .*?\n/s, "// no Styles alias here\n");
    expect(() => patchCssArtifact(broken, SAMPLE_UTILITIES, SAMPLE_CONDITIONS)).toThrow(
      /`Styles` type alias not found/,
    );
  });

  it("throws a self-diagnosing error when the SystemStyleObject import is missing", () => {
    const broken = FIXTURE_SOURCE.replace(
      "import type { SystemStyleObject } from '../types/index';",
      "// no SystemStyleObject import here",
    );
    expect(() => patchCssArtifact(broken, SAMPLE_UTILITIES, SAMPLE_CONDITIONS)).toThrow(
      /`SystemStyleObject` import not found/,
    );
  });

  it("locates anchors despite benign whitespace drift in Panda's emit", () => {
    // Insert extra spaces and blank lines around the splice points. These
    // would have broken the previous string-anchor matcher, but the AST
    // locator finds the nodes by shape regardless.
    const drifted = FIXTURE_SOURCE.replace(
      "type Styles = SystemStyleObject | undefined | null | false",
      "\n\ntype  Styles  =  SystemStyleObject  |  undefined  |  null  |  false\n",
    );
    expect(() => patchCssArtifact(drifted, SAMPLE_UTILITIES, SAMPLE_CONDITIONS)).not.toThrow();
    const patched = format(patchCssArtifact(drifted, SAMPLE_UTILITIES, SAMPLE_CONDITIONS));
    expect(patched).toContain("type Styles = BearbonesSystemStyleObject");
    expect(patched).not.toContain("type Styles = SystemStyleObject | undefined");
  });

  it("locates anchors despite alternate quote style in Panda's import", () => {
    const drifted = FIXTURE_SOURCE.replace(
      "import type { SystemStyleObject } from '../types/index';",
      'import type { SystemStyleObject } from "../types/index";',
    );
    expect(() => patchCssArtifact(drifted, SAMPLE_UTILITIES, SAMPLE_CONDITIONS)).not.toThrow();
    const patched = format(patchCssArtifact(drifted, SAMPLE_UTILITIES, SAMPLE_CONDITIONS));
    expect(patched).toContain("export type BearbonesUtilityName");
  });

  it("does not emit any per-marker registry augmentation", () => {
    // The marker-registry augmentation, conditions augmentation, and per-modifier
    // overloads are all gone — the chain lowers to raw selectors that match Panda's
    // existing `AnySelector` type without any registry codegen.
    const patched = format(patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS));
    expect(patched).not.toContain("declare module 'bearbones'");
    expect(patched).not.toContain("declare module '../types/conditions'");
    expect(patched).not.toContain("BearbonesMarkerRegistry");
    expect(patched).not.toContain("BearbonesMarkerConditionKey");
  });

  it("matches snapshot for a representative utility list", () => {
    const patched = format(patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS));
    expect(patched).toMatchSnapshot();
  });
});

describe("patchCssRuntime", () => {
  it("appends a marker stub that throws", () => {
    const out = patchCssRuntime("/* runtime */\nexport const css = ...;\n");
    expect(out).toContain("export function marker(_id)");
    expect(out).toContain("throw new Error");
    expect(out).toContain("@bearbones/vite transform did not run");
  });

  it("is idempotent — re-patching does not append a second copy", () => {
    const once = patchCssRuntime("/* runtime */\n");
    const twice = patchCssRuntime(once);
    expect(twice).toBe(once);
  });
});

describe("patchArtifacts", () => {
  it("patches the css.d.ts file inside the css-fn artifact", () => {
    const artifacts: PandaArtifact[] = [
      {
        id: "css-fn",
        files: [
          { file: "css.d.ts", code: FIXTURE_SOURCE },
          { file: "css.mjs", code: "/* runtime */\n" },
        ],
      },
    ];
    const out = patchArtifacts(artifacts);
    const cssDts = out[0]?.files.find((f) => f.file === "css.d.ts");
    expect(cssDts?.code).toContain("BearbonesSystemStyleObject");
    // The runtime mjs file gets the marker stub.
    const cssMjs = out[0]?.files.find((f) => f.file === "css.mjs");
    expect(cssMjs?.code).toContain("export function marker(_id)");
  });

  it("leaves unrelated artifacts unchanged", () => {
    const artifacts: PandaArtifact[] = [
      {
        id: "cva",
        files: [{ file: "cva.d.ts", code: "// cva content" }],
      },
      {
        id: "css-fn",
        files: [{ file: "css.d.ts", code: FIXTURE_SOURCE }],
      },
    ];
    const out = patchArtifacts(artifacts);
    expect(out[0]).toEqual(artifacts[0]);
  });

  it("no-ops when the css-fn artifact has no css.d.ts file", () => {
    const artifacts: PandaArtifact[] = [
      {
        id: "css-fn",
        files: [{ file: "css.mjs", code: "/* runtime */\n" }],
      },
    ];
    const out = patchArtifacts(artifacts);
    // The runtime stub still gets injected even if css.d.ts is absent.
    const cssMjs = out[0]?.files.find((f) => f.file === "css.mjs");
    expect(cssMjs?.code).toContain("export function marker(_id)");
  });

  it("no-ops when the css.d.ts file has undefined code", () => {
    const artifacts: PandaArtifact[] = [
      {
        id: "css-fn",
        files: [{ file: "css.d.ts", code: undefined }],
      },
    ];
    const out = patchArtifacts(artifacts);
    expect(out).toEqual(artifacts);
  });
});

describe("loadTemplate", () => {
  // Contract test guarding the template/renderer interface: the renderer in
  // `codegen-patch-render.ts` substitutes specific sentinel strings, and
  // these must exist in the templates verbatim or the renderer throws.
  it("returns the css-d-ts-injected template with the utility-names sentinel", () => {
    const source = loadTemplate("css-d-ts-injected");
    expect(source).toContain("// ---bearbones-template-emit-below---");
    expect(source).toContain('"__BEARBONES_UTILITY_NAMES__"');
  });

  it("returns the css-d-ts-marker template with the condition placeholder sentinel", () => {
    const source = loadTemplate("css-d-ts-marker");
    expect(source).toContain("// ---bearbones-template-emit-below---");
    expect(source).toContain('"__BEARBONES_CONDITION_PLACEHOLDER__"');
  });

  it("returns the css-mjs-marker-stub template with the runtime sentinel comment", () => {
    const source = loadTemplate("css-mjs-marker-stub");
    expect(source).toContain("// ---bearbones-template-emit-below---");
    expect(source).toContain("/* @bearbones/vite: marker stub */");
  });
});
