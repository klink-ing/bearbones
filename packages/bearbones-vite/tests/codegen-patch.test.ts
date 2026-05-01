import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { patchCssArtifact, patchArtifacts, type PandaArtifact } from "../src/codegen-patch.ts";

const FIXTURE_PATH = join(__dirname, "fixtures", "panda-css.d.ts");
const FIXTURE_SOURCE = readFileSync(FIXTURE_PATH, "utf8");

const SAMPLE_UTILITIES = ["p-4", "bg-blue-500", "flex"] as const;

describe("patchCssArtifact", () => {
  it("injects BearbonesUtilityName, BearbonesNested, BearbonesSystemStyleObject", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES);
    expect(patched).toContain("export type BearbonesUtilityName =");
    expect(patched).toContain("export type BearbonesNested<P>");
    expect(patched).toContain("export type BearbonesSystemStyleObject");
  });

  it("includes every utility name passed in as a quoted union member", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES);
    for (const name of SAMPLE_UTILITIES) {
      expect(patched).toContain(`| "${name}"`);
    }
  });

  it("emits `never` when no utilities are passed", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, []);
    expect(patched).toContain("export type BearbonesUtilityName =\nnever");
  });

  it("rewrites the Styles type alias to point at BearbonesSystemStyleObject", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES);
    expect(patched).toContain(
      "type Styles = BearbonesSystemStyleObject | undefined | null | false",
    );
    // The original Panda alias must be gone — otherwise both definitions would
    // collide and the patch would silently fail at type-check time.
    expect(patched).not.toContain("type Styles = SystemStyleObject | undefined | null | false");
  });

  it("imports the Panda helper types it references", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES);
    expect(patched).toContain("import type { Nested, Conditions } from '../types/conditions';");
    expect(patched).toContain("import type { Selectors, AnySelector } from '../types/selectors';");
    expect(patched).toContain(
      "import type { SystemProperties, CssVarProperties } from '../types/style-props';",
    );
  });

  it("preserves the rest of Panda's emitted file (CssFunction, css const)", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES);
    expect(patched).toContain("interface CssFunction");
    expect(patched).toContain("export declare const css: CssFunction;");
    expect(patched).toContain("interface CssRawFunction");
  });

  it("throws a self-diagnosing error when the Styles anchor is missing", () => {
    const broken = FIXTURE_SOURCE.replace(
      "type Styles = SystemStyleObject | undefined | null | false",
      "type Styles = SomethingElse",
    );
    expect(() => patchCssArtifact(broken, SAMPLE_UTILITIES)).toThrow(/expected anchor not found/);
  });

  it("throws a self-diagnosing error when the Panda import marker is missing", () => {
    const broken = FIXTURE_SOURCE.replace(
      "import type { SystemStyleObject } from '../types/index';",
      "import { Foo } from 'somewhere-else';",
    );
    expect(() => patchCssArtifact(broken, SAMPLE_UTILITIES)).toThrow(
      /expected Panda import marker not found/,
    );
  });

  it("matches snapshot for a representative utility list", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES);
    expect(patched).toMatchSnapshot();
  });
});

describe("patchArtifacts", () => {
  it("patches the css.d.ts file inside the css-fn artifact", () => {
    const artifacts: PandaArtifact[] = [
      {
        id: "css-fn",
        files: [
          { file: "css.d.ts", code: FIXTURE_SOURCE },
          { file: "css.mjs", code: "/* runtime */" },
        ],
      },
    ];
    const out = patchArtifacts(artifacts);
    const cssDts = out[0]?.files.find((f) => f.file === "css.d.ts");
    expect(cssDts?.code).toContain("BearbonesSystemStyleObject");
    // The runtime mjs file is untouched.
    const cssMjs = out[0]?.files.find((f) => f.file === "css.mjs");
    expect(cssMjs?.code).toBe("/* runtime */");
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
        files: [{ file: "css.mjs", code: "/* runtime */" }],
      },
    ];
    const out = patchArtifacts(artifacts);
    expect(out).toEqual(artifacts);
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
