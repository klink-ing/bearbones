import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  patchCssArtifact,
  patchCssRuntime,
  patchArtifacts,
  type PandaArtifact,
} from "../src/codegen-patch.ts";

// Fixture is named `.d.ts.txt` (not `.d.ts`) so oxfmt and tsc skip it.
// We need Panda's *exact* emitted bytes — including its single-quote import
// style and missing trailing semicolons — to assert that our string-based
// patcher's anchors match what the live Panda codegen produces. Letting the
// repo formatter rewrite this file would silently break the marker match.
const FIXTURE_PATH = join(__dirname, "fixtures", "panda-css.d.ts.txt");
const FIXTURE_SOURCE = readFileSync(FIXTURE_PATH, "utf8");

const SAMPLE_UTILITIES = ["p-4", "bg-blue-500", "flex"] as const;
const SAMPLE_CONDITIONS = [
  { name: "hover", value: "&:is(:hover, [data-hover])" },
  { name: "focus", value: "&:is(:focus, [data-focus])" },
  { name: "focusVisible", value: "&:is(:focus-visible, [data-focus-visible])" },
  { name: "dark", value: ".dark &" },
] as const;

describe("patchCssArtifact", () => {
  it("injects BearbonesUtilityName, BearbonesNested, BearbonesSystemStyleObject", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS);
    expect(patched).toContain("export type BearbonesUtilityName =");
    expect(patched).toContain("export type BearbonesNested<P>");
    expect(patched).toContain("export type BearbonesSystemStyleObject");
  });

  it("injects BearbonesMarker / BearbonesMarkerBuilder / marker declaration", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS);
    expect(patched).toContain("export interface BearbonesMarkerBuilder");
    expect(patched).toContain("export interface BearbonesMarker");
    expect(patched).toContain("export declare function marker<Id extends string>(id: Id)");
  });

  it("enumerates `_<name>` shortcut with the resolved condition VALUE as Cond parameter", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS);
    for (const { name, value } of SAMPLE_CONDITIONS) {
      expect(patched).toContain(
        `readonly _${name}: BearbonesMarkerBuilder<Id, ${JSON.stringify(value)}>`,
      );
    }
  });

  it("derives relation types from runtime function return types via ReturnType<typeof ...>", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS);
    // The marker observer + relation shape are derived from the return
    // types of `markerAnchor`, `substituteAmp`, and `composeRelationSelectors`
    // in `@bearbones/vite/marker-registry` — single source of truth, no
    // hand-maintained duplicate of the selector shapes in the type emit.
    expect(patched).toContain(
      "import type { composeRelationSelectors, markerAnchor, substituteAmp } from '@bearbones/vite';",
    );
    expect(patched).toContain('typeof markerAnchor<Id, "<HASH>">');
    expect(patched).toContain("typeof substituteAmp<Cond, BearbonesMarkerAnchor<Id>>");
    expect(patched).toContain(
      "readonly is: ReturnType<typeof composeRelationSelectors<BearbonesObserver<Id, Cond>>>;",
    );
  });

  it("emits a generic call form so literal condValue args produce concrete chain types", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS);
    expect(patched).toContain("<C extends string>(condValue: C): BearbonesMarkerBuilder<Id, C>");
  });

  it("includes every utility name passed in as a quoted union member", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS);
    for (const name of SAMPLE_UTILITIES) {
      expect(patched).toContain(`| "${name}"`);
    }
  });

  it("emits `never` when no utilities are passed", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, [], SAMPLE_CONDITIONS);
    expect(patched).toContain("export type BearbonesUtilityName =\nnever");
  });

  it("rewrites the Styles type alias to point at BearbonesSystemStyleObject", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS);
    expect(patched).toContain(
      "type Styles = BearbonesSystemStyleObject | undefined | null | false",
    );
    // The original Panda alias must be gone — otherwise both definitions would
    // collide and the patch would silently fail at type-check time.
    expect(patched).not.toContain("type Styles = SystemStyleObject | undefined | null | false");
  });

  it("imports the Panda helper types it references", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS);
    expect(patched).toContain("import type { Nested, Conditions } from '../types/conditions';");
    expect(patched).toContain("import type { Selectors, AnySelector } from '../types/selectors';");
    expect(patched).toContain(
      "import type { SystemProperties, CssVarProperties } from '../types/style-props';",
    );
  });

  it("preserves the rest of Panda's emitted file (CssFunction, css const)", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS);
    expect(patched).toContain("interface CssFunction");
    expect(patched).toContain("export declare const css: CssFunction;");
    expect(patched).toContain("interface CssRawFunction");
  });

  it("throws a self-diagnosing error when the Styles anchor is missing", () => {
    const broken = FIXTURE_SOURCE.replace(
      "type Styles = SystemStyleObject | undefined | null | false",
      "type Styles = SomethingElse",
    );
    expect(() => patchCssArtifact(broken, SAMPLE_UTILITIES, SAMPLE_CONDITIONS)).toThrow(
      /expected anchor not found/,
    );
  });

  it("throws a self-diagnosing error when the Panda import marker is missing", () => {
    const broken = FIXTURE_SOURCE.replace(
      "import type { SystemStyleObject } from '../types/index';",
      "import { Foo } from 'somewhere-else';",
    );
    expect(() => patchCssArtifact(broken, SAMPLE_UTILITIES, SAMPLE_CONDITIONS)).toThrow(
      /expected Panda import marker not found/,
    );
  });

  it("does not emit any per-marker registry augmentation", () => {
    // The marker-registry augmentation, conditions augmentation, and per-modifier
    // overloads are all gone — the chain lowers to raw selectors that match Panda's
    // existing `AnySelector` type without any registry codegen.
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS);
    expect(patched).not.toContain("declare module 'bearbones'");
    expect(patched).not.toContain("declare module '../types/conditions'");
    expect(patched).not.toContain("BearbonesMarkerRegistry");
    expect(patched).not.toContain("BearbonesMarkerConditionKey");
  });

  it("matches snapshot for a representative utility list", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_CONDITIONS);
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
