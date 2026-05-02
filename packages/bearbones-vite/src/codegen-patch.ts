/**
 * Patch Panda's emitted `styled-system/css/css.d.ts` so the `css()` function
 * accepts bearbones utility strings in addition to Panda's standard
 * SystemStyleObject input.
 *
 * Wired into Panda's `codegen:prepare` hook in `index.ts`. Runs once per
 * codegen pass, after `config:resolved` (so every `group()` declaration is
 * already registered as a Panda condition) and immediately before Panda
 * writes any artifact to disk.
 *
 * The patch is purely a type-level change. The runtime `css()` function in
 * `css.mjs` is untouched — Panda's implementation already accepts arbitrary
 * input shapes; the missing piece was the static type surface telling the
 * compiler those shapes are valid.
 *
 * Strategy: locate Panda's `type Styles = ...` line by exact-match anchor and
 * rewrite it to point at a widened type tree (`BearbonesSystemStyleObject`)
 * defined inline above. The widened tree mirrors Panda's own `Nested<P>`
 * structure so that:
 *   - The whole tree may also be a `BearbonesUtilityName` (utility-string leaf).
 *   - Every condition / selector value position also accepts a utility string
 *     or an array of styles (matching the lowering transform's runtime contract).
 *   - CSS property values (`P` in Panda's recursion) remain strict — utility
 *     strings are *not* accepted as values for `padding`, `color`, etc.
 *
 * If Panda's emitted format ever changes such that the anchor isn't found,
 * the patch throws a recognizable error rather than silently producing wrong
 * types. The build fails loudly and the diagnosis is one Panda changelog
 * read away.
 */

import { listUtilities } from "./utility-map.ts";
import { listMarkers, MARKER_STATES, type RegisteredMarker } from "./marker-registry.ts";

/**
 * The anchor we replace in Panda's emitted `css.d.ts`. Captured verbatim from
 * `apps/website/styled-system/css/css.d.ts` after a real `panda codegen` run.
 * If Panda renames `Styles` or restructures the file, this anchor stops
 * matching and `patchCssArtifact` throws.
 */
const STYLES_ANCHOR = "type Styles = SystemStyleObject | undefined | null | false";

/**
 * Patch the source of a single `styled-system/css/css.d.ts` file. Returns the
 * patched source string. Pure function — no I/O, no side effects.
 *
 * Throws if the source doesn't contain the expected anchor. The thrown error
 * names the missing anchor explicitly so the failure is self-diagnosing.
 */
export function patchCssArtifact(
  source: string,
  utilityNames: readonly string[],
  markers: readonly RegisteredMarker[] = [],
): string {
  if (!source.includes(STYLES_ANCHOR)) {
    throw new Error(
      `@bearbones/vite codegen-patch: expected anchor not found in css.d.ts.\n` +
        `Anchor: ${JSON.stringify(STYLES_ANCHOR)}\n` +
        `This usually means a Panda upgrade changed the emitted format. ` +
        `Re-capture the anchor from a fresh \`panda codegen\` run and update ` +
        `STYLES_ANCHOR in packages/bearbones-vite/src/codegen-patch.ts.`,
    );
  }

  const utilityUnion = renderUtilityUnion(utilityNames);
  const injectedTypes = renderInjectedTypes(utilityUnion);
  const patchedStyles = "type Styles = BearbonesSystemStyleObject | undefined | null | false";

  // Insert the injected types immediately after the existing `import` line so
  // they're declared before the `Styles` alias references them. The types pull
  // in `Nested`, `Selectors`, `AnySelector`, `Conditions`, `SystemProperties`,
  // and `CssVarProperties` from sibling artifact files inside `../types/`.
  const importBlock = renderImportBlock();

  // Place injected imports + types directly after Panda's existing
  // `import type { SystemStyleObject } ...` line so we don't fight Panda's
  // own header ordering.
  const pandaImportMarker = "import type { SystemStyleObject } from '../types/index';";
  if (!source.includes(pandaImportMarker)) {
    throw new Error(
      `@bearbones/vite codegen-patch: expected Panda import marker not found.\n` +
        `Marker: ${JSON.stringify(pandaImportMarker)}\n` +
        `If Panda changed how it imports SystemStyleObject, update the marker ` +
        `in packages/bearbones-vite/src/codegen-patch.ts.`,
    );
  }

  const markerRegistryAugmentation = renderMarkerRegistryAugmentation(markers);

  // The marker-registry augmentation is appended at the end of the file. It's
  // a `declare module 'bearbones'` block that injects literal-string condition
  // keys for every marker discovered by the prescan. Consumers' `cardMarker.hover`
  // then has type `'_markerHover_card_a27adb16'` (specific) instead of
  // `` `_markerHover_card_${string}` `` (template literal) — eliminating the
  // string-index widening that template literals cause when used as computed
  // keys alongside other static keys in the same object literal.
  return (
    source
      .replace(pandaImportMarker, `${pandaImportMarker}\n${importBlock}\n${injectedTypes}`)
      .replace(STYLES_ANCHOR, patchedStyles) + markerRegistryAugmentation
  );
}

/**
 * Convenience wrapper that patches against the live utility + marker lists.
 * Used by the `codegen:prepare` hook in production; tests pass fixed inputs
 * to keep snapshots stable.
 */
export function patchCssArtifactLive(source: string): string {
  return patchCssArtifact(source, listUtilities(), listMarkers());
}

function renderUtilityUnion(names: readonly string[]): string {
  if (names.length === 0) return "never";
  // One name per line for readability inside the generated file.
  return names.map((n) => `  | ${JSON.stringify(n)}`).join("\n");
}

function renderImportBlock(): string {
  return [
    "import type { Nested, Conditions } from '../types/conditions';",
    "import type { Selectors, AnySelector } from '../types/selectors';",
    "import type { SystemProperties, CssVarProperties } from '../types/style-props';",
  ].join("\n");
}

function renderInjectedTypes(utilityUnion: string): string {
  // The recursion shape mirrors Panda's `Nested<P>`. The two material
  // additions are the `BearbonesUtilityName` leaf (whole tree may also be a
  // utility string) and `readonly BearbonesNested<P>[]` at every condition /
  // selector value position (matching the transform's runtime acceptance of
  // arrays of utility strings).
  //
  // BearbonesNestedObject is intentionally factored out from BearbonesNested
  // so that `Omit<..., 'base'>` (used to define BearbonesSystemStyleObject —
  // mirroring Panda's own SystemStyleObject) wraps ONLY the object branch.
  // Distributing `Omit` over `BearbonesUtilityName | ObjectType` widens the
  // string-literal union to a structural string type and the closed-set
  // checking would silently break.
  // No `BearbonesMarkerConditionKey` mapped-type slot here. Marker condition
  // keys ARE keys of Panda's `Conditions` interface (registered by the bearbones
  // preset + prescan), so `[K in keyof Conditions]` already covers them. Adding
  // a separate template-literal mapped slot used to introduce a `string` index
  // signature on consumer object literals that conflicted with Panda's
  // `CssVarProperties[ '--${string}' ]` index — see the marker-registry
  // augmentation appended below for how we narrow `cardMarker.hover` to a
  // specific literal that lands inside `keyof Conditions` directly.
  return [
    "export type BearbonesUtilityName =",
    utilityUnion,
    ";",
    "",
    "type BearbonesNestedObject<P> = P & {",
    "  [K in Selectors]?: BearbonesNested<P> | readonly BearbonesNested<P>[]",
    "} & {",
    "  [K in AnySelector]?: BearbonesNested<P> | readonly BearbonesNested<P>[]",
    "} & {",
    "  [K in keyof Conditions]?: BearbonesNested<P> | readonly BearbonesNested<P>[]",
    "};",
    "",
    "export type BearbonesNested<P> = BearbonesUtilityName | BearbonesNestedObject<P>;",
    "",
    "export type BearbonesSystemStyleObject =",
    "  | BearbonesUtilityName",
    "  | Omit<BearbonesNestedObject<SystemProperties & CssVarProperties>, 'base'>;",
    "",
  ].join("\n");
}

/**
 * Render a `declare module 'bearbones'` block that augments the empty
 * `BearbonesMarkerRegistry` interface in the bearbones package with one
 * entry per marker discovered by the prescan. Each entry uses literal-string
 * condition keys (e.g., `hover: '_markerHover_card_a27adb16'`) matching the
 * actual hashed condition names registered with Panda.
 *
 * Consumers' `cardMarker.hover` then resolves through the package's
 * `BearbonesMarkerRuntime<Id>` type to a specific literal, which is a member
 * of `keyof Conditions` — letting `[cardMarker.hover]: ...` narrow correctly
 * inside object literals without forcing TypeScript to widen to a string
 * index signature.
 */
function renderMarkerRegistryAugmentation(markers: readonly RegisteredMarker[]): string {
  if (markers.length === 0) return "";
  const entries = markers
    .map((marker) => {
      const fields = [
        `      readonly anchor: ${JSON.stringify(marker.anchorClass)};`,
        ...MARKER_STATES.map((state) => {
          const conditionName = `_marker${capitalize(state)}_${marker.suffix}`;
          return `      readonly ${state}: ${JSON.stringify(conditionName)};`;
        }),
      ];
      return `    ${JSON.stringify(marker.id)}: {\n${fields.join("\n")}\n    };`;
    })
    .join("\n");

  return [
    "",
    "",
    "// --- Marker registry: emitted by @bearbones/vite codegen:prepare ---",
    "// One entry per marker discovered by the prescan. Augments the empty",
    "// `BearbonesMarkerRegistry` interface in the bearbones package so",
    "// `marker(id)` returns a shape with literal-string condition keys.",
    "declare module 'bearbones' {",
    "  interface BearbonesMarkerRegistry {",
    entries,
    "  }",
    "}",
    "",
  ].join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Patch a Panda `Artifact[]` array in-place by finding the `css-fn` artifact's
 * `css.d.ts` file and rewriting its `code`. Used by the `codegen:prepare` hook.
 *
 * No-op (returns the input unchanged) if the artifact isn't present. Some
 * Panda invocations only regenerate a subset of artifacts; the type patch
 * only matters when the css.d.ts itself is being written.
 */
export function patchArtifacts(artifacts: PandaArtifact[]): PandaArtifact[] {
  return artifacts.map((artifact) => {
    if (artifact.id !== "css-fn") return artifact;
    return {
      ...artifact,
      files: artifact.files.map((file) => {
        if (file.file !== "css.d.ts") return file;
        if (file.code === undefined) return file;
        return { ...file, code: patchCssArtifactLive(file.code) };
      }),
    };
  });
}

/**
 * Local mirror of Panda's `Artifact` shape and `ArtifactId` union, copied
 * verbatim from `@pandacss/types/dist/artifact`. We mirror rather than
 * import because `@pandacss/types/index` transitively re-exports through
 * `config.d.ts` which imports `pkg-types`, which in turn fails to resolve
 * a `CompilerOptions` export against the `typescript` version this project
 * pins. Mirroring keeps types accurate at the hook boundary without
 * dragging unrelated transitive deps into rolldown's bundle pass.
 *
 * If Panda renames or restructures the artifact shape, the type-check at
 * the hook signature in `index.ts` (which uses these types) catches the
 * drift; bump the mirror to match.
 */
export type PandaArtifactId =
  | "helpers"
  | "keyframes"
  | "design-tokens"
  | "types"
  | "css-fn"
  | "cva"
  | "sva"
  | "cx"
  | "create-recipe"
  | "recipes"
  | "recipes-index"
  | "patterns"
  | "patterns-index"
  | "jsx-is-valid-prop"
  | "jsx-helpers"
  | "jsx-factory"
  | "jsx-patterns"
  | "jsx-create-style-context"
  | "jsx-patterns-index"
  | "css-index"
  | "themes"
  | "package.json"
  | "types-jsx"
  | "types-entry"
  | "types-styles"
  | "types-conditions"
  | "types-gen"
  | "types-gen-system"
  | "static-css"
  | "styles.css"
  | "styles"
  | `recipes.${string}`
  | `patterns.${string}`;

export interface PandaArtifactFile {
  file: string;
  code: string | undefined;
}

export interface PandaArtifact {
  id: PandaArtifactId;
  dir?: string[];
  files: PandaArtifactFile[];
}
