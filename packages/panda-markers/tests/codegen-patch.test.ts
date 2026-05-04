import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  applyCssDtsPatches,
  applyCssMjsPatches,
  patchPandaArtifacts,
  type PandaArtifact,
} from "@klinking/panda-utils";
import {
  buildCssDtsPatches,
  buildCssMjsPatches,
  markersPatchContributor,
} from "../src/codegen-patch.ts";
import { loadTemplate } from "../src/codegen-templates.ts";

const FIXTURE_PATH = join(__dirname, "fixtures", "panda-css.d.ts.txt");
const FIXTURE_SOURCE = readFileSync(FIXTURE_PATH, "utf8");

const SAMPLE_CONDITIONS = [
  { name: "hover", value: "&:is(:hover, [data-hover])" },
  { name: "focus", value: "&:is(:focus, [data-focus])" },
  { name: "focusVisible", value: "&:is(:focus-visible, [data-focus-visible])" },
  { name: "dark", value: ".dark &" },
] as const;

const PKG_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const OXFMT_BIN = join(PKG_DIR, "..", "..", "node_modules", ".bin", "oxfmt");

function format(source: string, filename = "css.d.ts"): string {
  return execFileSync(OXFMT_BIN, [`--stdin-filepath=${filename}`], {
    input: source,
    cwd: PKG_DIR,
    encoding: "utf8",
  });
}

function patchDts(source: string, conditions: readonly { name: string; value: string }[]): string {
  return applyCssDtsPatches(source, buildCssDtsPatches(source, conditions));
}

describe("buildCssDtsPatches", () => {
  it("injects BearbonesMarker / BearbonesMarkerBuilder / marker declaration", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_CONDITIONS));
    expect(patched).toContain("export interface BearbonesMarkerBuilder");
    expect(patched).toContain("export interface BearbonesMarker");
    expect(patched).toContain("export declare function marker<Id extends string>(id: Id)");
  });

  it("enumerates the host's condition vocabulary in a single BearbonesMarkerConditions map", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_CONDITIONS));
    expect(patched).toContain("type BearbonesMarkerConditions = {");
    for (const { name, value } of SAMPLE_CONDITIONS) {
      const quoted = `readonly ${JSON.stringify(name)}: ${JSON.stringify(value)};`;
      const bare = `readonly ${name}: ${JSON.stringify(value)};`;
      expect(
        patched.includes(quoted) || patched.includes(bare),
        `expected condition ${name} to appear as a typed map entry`,
      ).toBe(true);
    }
    for (const { value } of SAMPLE_CONDITIONS) {
      const occurrences = patched.split(JSON.stringify(value)).length - 1;
      expect(occurrences, `condition ${JSON.stringify(value)} appears ${occurrences} times`).toBe(
        1,
      );
    }
  });

  it("derives _<name> shortcuts via mapped type over BearbonesMarkerConditions", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_CONDITIONS));
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
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_CONDITIONS));
    expect(patched).toContain("import type {");
    expect(patched).toContain("composeRelationSelectors,");
    expect(patched).toContain("markerAnchor,");
    expect(patched).toContain("markerAnchorClass,");
    expect(patched).toContain("substituteAmp,");
    expect(patched).toContain('} from "@klinking/panda-markers";');
    expect(patched).toContain("readonly anchor: ReturnType<typeof markerAnchorClass<Id, string>>;");
    expect(patched).toContain('typeof markerAnchor<Id, "<HASH>">');
    expect(patched).toContain("typeof substituteAmp<Cond, BearbonesMarkerAnchor<Id>>");
    expect(patched).toContain(
      "readonly is: ReturnType<typeof composeRelationSelectors<BearbonesObserver<Id, Cond>>>;",
    );
  });

  it("emits a generic call form so literal condValue args produce concrete chain types", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_CONDITIONS));
    expect(patched).toContain("<C extends string>(condValue: C): BearbonesMarkerBuilder<Id, C>");
  });

  it("does NOT modify the Styles type alias (that's the shorthand plugin's job)", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_CONDITIONS));
    // Markers leaves Styles alone — the original Panda alias should be intact.
    expect(patched).toContain("type Styles = SystemStyleObject | undefined | null | false");
    expect(patched).not.toContain("type Styles = BearbonesSystemStyleObject");
  });

  it("preserves the rest of Panda's emitted file (CssFunction, css const)", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_CONDITIONS));
    expect(patched).toContain("interface CssFunction");
    expect(patched).toContain("export declare const css: CssFunction;");
  });

  it("throws a self-diagnosing error when the Styles type alias is missing", () => {
    const broken = FIXTURE_SOURCE.replace(/type Styles = .*?\n/s, "// no Styles alias here\n");
    expect(() => buildCssDtsPatches(broken, SAMPLE_CONDITIONS)).toThrow(
      /`Styles` type alias not found/,
    );
  });

  it("matches snapshot for a representative condition list", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_CONDITIONS));
    expect(patched).toMatchSnapshot();
  });
});

describe("buildCssMjsPatches", () => {
  it("appends a marker stub that throws", () => {
    const out = applyCssMjsPatches(
      "/* runtime */\nexport const css = ...;\n",
      buildCssMjsPatches(),
    );
    expect(out).toContain("export function marker(_id)");
    expect(out).toContain("throw new Error");
    expect(out).toContain("@klinking/panda-markers");
  });

  it("is idempotent — re-patching does not append a second copy", () => {
    const once = applyCssMjsPatches("/* runtime */\n", buildCssMjsPatches());
    const twice = applyCssMjsPatches(once, buildCssMjsPatches());
    expect(twice).toBe(once);
  });
});

describe("patchPandaArtifacts (markers contributor)", () => {
  it("patches both the css.d.ts file and the css.mjs file inside the css-fn artifact", () => {
    const artifacts: PandaArtifact[] = [
      {
        id: "css-fn",
        files: [
          { file: "css.d.ts", code: FIXTURE_SOURCE },
          { file: "css.mjs", code: "/* runtime */\nexport const css = ...;\n" },
        ],
      },
    ];
    const out = patchPandaArtifacts(artifacts, markersPatchContributor);
    const cssDts = out[0]?.files.find((f) => f.file === "css.d.ts");
    expect(cssDts?.code).toContain("BearbonesMarker");
    const cssMjs = out[0]?.files.find((f) => f.file === "css.mjs");
    expect(cssMjs?.code).toContain("export function marker(_id)");
  });

  it("leaves unrelated artifacts unchanged", () => {
    const artifacts: PandaArtifact[] = [
      {
        id: "cva",
        files: [{ file: "cva.d.ts", code: "// cva content" }],
      },
    ];
    const out = patchPandaArtifacts(artifacts, markersPatchContributor);
    expect(out[0]).toEqual(artifacts[0]);
  });
});

describe("loadTemplate", () => {
  it("returns the css-d-ts-marker template with the condition placeholder sentinel", () => {
    const source = loadTemplate("css-d-ts-marker");
    expect(source).toContain("// ---bearbones-template-emit-below---");
    expect(source).toContain('"__BEARBONES_CONDITION_PLACEHOLDER__"');
  });

  it("returns the css-mjs-marker-stub template with the runtime sentinel comment", () => {
    const source = loadTemplate("css-mjs-marker-stub");
    expect(source).toContain("// ---bearbones-template-emit-below---");
    expect(source).toContain("/* @klinking/panda-markers: marker stub */");
  });
});
