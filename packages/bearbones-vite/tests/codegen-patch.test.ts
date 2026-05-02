import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { patchCssArtifact, patchArtifacts, type PandaArtifact } from "../src/codegen-patch.ts";
import { __resetRegistry, type RegisteredMarker } from "../src/marker-registry.ts";

beforeEach(() => {
  __resetRegistry();
});

const SAMPLE_MARKERS: readonly RegisteredMarker[] = [
  {
    id: "card",
    modulePath: "/virtual/markers.ts",
    hash: "a27adb16",
    suffix: "card_a27adb16",
    anchorClass: "bearbones-marker-card_a27adb16",
  },
  {
    id: "row",
    modulePath: "/virtual/markers.ts",
    hash: "5ec0c285",
    suffix: "row_5ec0c285",
    anchorClass: "bearbones-marker-row_5ec0c285",
  },
];

// Fixture is named `.d.ts.txt` (not `.d.ts`) so oxfmt and tsc skip it.
// We need Panda's *exact* emitted bytes — including its single-quote import
// style and missing trailing semicolons — to assert that our string-based
// patcher's anchors match what the live Panda codegen produces. Letting the
// repo formatter rewrite this file would silently break the marker match.
const FIXTURE_PATH = join(__dirname, "fixtures", "panda-css.d.ts.txt");
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

  it("does NOT inject the obsolete BearbonesMarkerConditionKey template type", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_MARKERS);
    // Marker condition keys live in `keyof Conditions` directly (registered by
    // the bearbones preset). The old template-literal mapped slot caused
    // index-signature widening; it should be gone.
    expect(patched).not.toContain("BearbonesMarkerConditionKey");
  });
});

describe("patchCssArtifact — marker registry augmentation", () => {
  it("appends a `declare module 'bearbones'` block when markers are registered", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_MARKERS);
    expect(patched).toContain("declare module 'bearbones'");
    expect(patched).toContain("interface BearbonesMarkerRegistry");
  });

  it("emits one entry per registered marker with anchor + raw-selector underscore builders", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_MARKERS);
    // Card entry: id key, anchor class, raw-selector typed builder per state.
    expect(patched).toContain('"card": {');
    expect(patched).toContain('readonly anchor: "bearbones-marker-card_a27adb16";');
    expect(patched).toContain(
      'readonly _hover: { readonly is: { readonly ancestor: ".bearbones-marker-card_a27adb16:is(:hover, [data-hover]) &"',
    );
    expect(patched).toContain(
      'readonly _focusVisible: { readonly is: { readonly ancestor: ".bearbones-marker-card_a27adb16:focus-visible &"',
    );
    // Row entry exists too.
    expect(patched).toContain('"row": {');
    expect(patched).toContain(
      'readonly _hover: { readonly is: { readonly ancestor: ".bearbones-marker-row_5ec0c285:is(:hover, [data-hover]) &"',
    );
    // No legacy condition-name strings or shortcut properties.
    expect(patched).not.toMatch(/readonly hover: "_markerHover_/);
    expect(patched).not.toMatch(/readonly _hover: \{ readonly is: \{ readonly ancestor: "_marker_/);
  });

  it("omits the augmentation block entirely when no markers are registered", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, []);
    expect(patched).not.toContain("declare module 'bearbones'");
    expect(patched).not.toContain("BearbonesMarkerRegistry");
  });
});

describe("patchCssArtifact — relational marker chains", () => {
  it("emits a single wide-string call overload per marker entry", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_MARKERS);
    // The call signature returns template-literal-typed raw selectors anchored
    // at the marker's class. No per-modifier overloads, just one wide string.
    expect(patched).toContain(
      "(selector: string): { readonly is: { readonly ancestor: `.bearbones-marker-card_a27adb16${string} &`",
    );
    expect(patched).toContain("`&:has(.bearbones-marker-card_a27adb16${string})`");
    expect(patched).toContain(
      "`& ~ .bearbones-marker-card_a27adb16${string}, .bearbones-marker-card_a27adb16${string} ~ &`",
    );
  });

  it("does not emit a Conditions augmentation block", () => {
    // The whole condition-registration pipeline is gone — chains lower to raw
    // selectors that Panda parses natively, no `keyof Conditions` widening
    // needed.
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_MARKERS);
    expect(patched).not.toContain("declare module '../types/conditions'");
    expect(patched).not.toMatch(/\[k: `_marker_/);
  });

  it("does not emit per-modifier call overloads", () => {
    const patched = patchCssArtifact(FIXTURE_SOURCE, SAMPLE_UTILITIES, SAMPLE_MARKERS);
    // Each marker entry has exactly one `(selector:` call signature (the wide
    // fallback). No closed-set overloads per registered modifier remain.
    const callSignatures = patched.match(/\(selector:[^)]*\):/g) ?? [];
    expect(callSignatures.length).toBe(SAMPLE_MARKERS.length);
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
