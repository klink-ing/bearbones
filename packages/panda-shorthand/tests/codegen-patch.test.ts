import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { applyCssDtsPatches, patchPandaArtifacts, type PandaArtifact } from "@klinking/panda-utils";
import { buildCssDtsPatches, shorthandPatchContributor } from "../src/codegen-patch.ts";
import { loadTemplate } from "../src/codegen-templates.ts";

// Fixture is named `.d.ts.txt` (not `.d.ts`) so oxfmt and tsc skip it.
// We need Panda's *exact* emitted bytes — including its single-quote import
// style and missing trailing semicolons — to assert that our AST-based
// splice locator handles the real shape Panda emits.
const FIXTURE_PATH = join(__dirname, "fixtures", "panda-css.d.ts.txt");
const FIXTURE_SOURCE = readFileSync(FIXTURE_PATH, "utf8");

const SAMPLE_UTILITIES = ["p-4", "bg-blue-500", "flex"] as const;

const PKG_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const OXFMT_BIN = join(PKG_DIR, "..", "..", "node_modules", ".bin", "oxfmt");

function format(source: string, filename = "css.d.ts"): string {
  return execFileSync(OXFMT_BIN, [`--stdin-filepath=${filename}`], {
    input: source,
    cwd: PKG_DIR,
    encoding: "utf8",
  });
}

function patchDts(source: string, utils: readonly string[]): string {
  return applyCssDtsPatches(source, buildCssDtsPatches(source, utils));
}

describe("buildCssDtsPatches", () => {
  it("injects BearbonesUtilityName / BearbonesNested / BearbonesSystemStyleObject", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_UTILITIES));
    expect(patched).toContain("export type BearbonesUtilityName =");
    expect(patched).toContain("export type BearbonesNested<P>");
    expect(patched).toContain("export type BearbonesSystemStyleObject");
  });

  it("rewrites the Styles type alias to point at BearbonesSystemStyleObject", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_UTILITIES));
    expect(patched).toContain(
      "type Styles = BearbonesSystemStyleObject | undefined | null | false",
    );
    expect(patched).not.toContain("type Styles = SystemStyleObject | undefined | null | false");
  });

  it("includes every utility name passed in as a quoted union member", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_UTILITIES));
    for (const name of SAMPLE_UTILITIES) {
      expect(patched).toContain(`"${name}"`);
    }
  });

  it("emits `never` when no utilities are passed", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, []));
    expect(patched).toContain("export type BearbonesUtilityName = never;");
  });

  it("imports the Panda helper types it references", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_UTILITIES));
    expect(patched).toContain('import type { Nested, Conditions } from "../types/conditions";');
    expect(patched).toContain('import type { Selectors, AnySelector } from "../types/selectors";');
    expect(patched).toContain(
      'import type { SystemProperties, CssVarProperties } from "../types/style-props";',
    );
  });

  it("preserves the rest of Panda's emitted file (CssFunction, css const)", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_UTILITIES));
    expect(patched).toContain("interface CssFunction");
    expect(patched).toContain("export declare const css: CssFunction;");
  });

  it("does NOT inject any marker types (those belong to @klinking/panda-markers)", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_UTILITIES));
    expect(patched).not.toContain("BearbonesMarker");
    expect(patched).not.toContain("export declare function marker");
  });

  it("throws a self-diagnosing error when the Styles type alias is missing", () => {
    const broken = FIXTURE_SOURCE.replace(/type Styles = .*?\n/s, "// no Styles alias here\n");
    expect(() => buildCssDtsPatches(broken, SAMPLE_UTILITIES)).toThrow(
      /`Styles` type alias not found/,
    );
  });

  it("locates anchors despite benign whitespace drift in Panda's emit", () => {
    const drifted = FIXTURE_SOURCE.replace(
      "type Styles = SystemStyleObject | undefined | null | false",
      "\n\ntype  Styles  =  SystemStyleObject  |  undefined  |  null  |  false\n",
    );
    expect(() => patchDts(drifted, SAMPLE_UTILITIES)).not.toThrow();
    const patched = format(patchDts(drifted, SAMPLE_UTILITIES));
    expect(patched).toContain("type Styles = BearbonesSystemStyleObject");
  });

  it("matches snapshot for a representative utility list", () => {
    const patched = format(patchDts(FIXTURE_SOURCE, SAMPLE_UTILITIES));
    expect(patched).toMatchSnapshot();
  });
});

describe("patchPandaArtifacts (shorthand contributor)", () => {
  it("patches the css.d.ts file inside the css-fn artifact", () => {
    const artifacts: PandaArtifact[] = [
      {
        id: "css-fn",
        files: [
          { file: "css.d.ts", code: FIXTURE_SOURCE },
          { file: "css.mjs", code: "/* runtime */\nexport const css = ...;\n" },
        ],
      },
    ];
    const out = patchPandaArtifacts(artifacts, shorthandPatchContributor);
    const cssDts = out[0]?.files.find((f) => f.file === "css.d.ts");
    expect(cssDts?.code).toContain("BearbonesSystemStyleObject");
    // Shorthand does NOT touch the runtime artifact — only types.
    const cssMjs = out[0]?.files.find((f) => f.file === "css.mjs");
    expect(cssMjs?.code).toBe("/* runtime */\nexport const css = ...;\n");
  });

  it("leaves unrelated artifacts unchanged", () => {
    const artifacts: PandaArtifact[] = [
      {
        id: "cva",
        files: [{ file: "cva.d.ts", code: "// cva content" }],
      },
    ];
    const out = patchPandaArtifacts(artifacts, shorthandPatchContributor);
    expect(out[0]).toEqual(artifacts[0]);
  });

  it("no-ops when the css.d.ts file has undefined code", () => {
    const artifacts: PandaArtifact[] = [
      {
        id: "css-fn",
        files: [{ file: "css.d.ts", code: undefined }],
      },
    ];
    const out = patchPandaArtifacts(artifacts, shorthandPatchContributor);
    expect(out).toEqual(artifacts);
  });
});

describe("loadTemplate", () => {
  it("returns the css-d-ts-injected template with the utility-names sentinel", () => {
    const source = loadTemplate("css-d-ts-injected");
    expect(source).toContain("// ---bearbones-template-emit-below---");
    expect(source).toContain('"__BEARBONES_UTILITY_NAMES__"');
  });
});
