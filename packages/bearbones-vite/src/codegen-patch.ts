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
import {
  buildRelationConditionName,
  listMarkers,
  MARKER_STATES,
  modifierHash,
  STATE_PSEUDO,
  type MarkerState,
  type RegisteredMarker,
} from "./marker-registry.ts";

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
  const conditionsAugmentation = renderConditionsAugmentation(markers);

  // The marker-registry augmentation is appended at the end of the file. It's
  // a `declare module 'bearbones'` block that injects literal-string call
  // overloads + `_<state>` builder properties for every marker discovered by
  // the prescan. Consumers' `cardMarker._hover.is.ancestor` then has type
  // `'_marker_card_a27adb16_ancestor_<modhash>'` (specific) instead of a
  // template-literal fallback — eliminating the string-index widening that
  // template literals cause when used as computed keys alongside other static
  // keys in the same object literal.
  //
  // The conditions augmentation is the open-set companion to the closed-set
  // marker registry: it widens `keyof Conditions` with template-literal index
  // signatures `_marker_<suffix>_<rel>_${string}` so the wide fallback
  // overload of `marker(...)` (returning template-literal-typed condition
  // keys) matches as a computed key even before the prescan has registered
  // the specific modifier hash. CSS extraction still lags by one codegen
  // pass for new modifiers, but TypeScript stays green throughout.
  return (
    source
      .replace(pandaImportMarker, `${pandaImportMarker}\n${importBlock}\n${injectedTypes}`)
      .replace(STYLES_ANCHOR, patchedStyles) +
    markerRegistryAugmentation +
    conditionsAugmentation
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
  // keys ARE keys of Panda's `Conditions` interface (registered by the
  // prescan), so `[K in keyof Conditions]` already covers them. Adding a
  // separate template-literal mapped slot used to introduce a `string` index
  // signature on consumer object literals that conflicted with Panda's
  // `CssVarProperties[ '--${string}' ]` index — see the marker-registry
  // augmentation appended below for how we narrow `cardMarker._hover.is.ancestor`
  // to a specific literal that lands inside `keyof Conditions` directly.
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
 * entry per marker discovered by the prescan. Each entry pairs the anchor
 * class with the typed `_<state>` builders, plus closed-set call overloads
 * for every modifier the prescan saw at a usage site.
 *
 * Consumers' `cardMarker._hover.is.ancestor` then resolves through the
 * package's `BearbonesMarkerRuntime<Id>` type to a specific literal that's a
 * member of `keyof Conditions` — letting `[cardMarker._hover.is.ancestor]: ...`
 * narrow correctly inside object literals without forcing TypeScript to
 * widen to a string index signature.
 */
function renderMarkerRegistryAugmentation(markers: readonly RegisteredMarker[]): string {
  if (markers.length === 0) return "";
  const entries = markers.map(renderMarkerEntry).join("\n");

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

/**
 * Render the per-marker entry. Each entry is a function-with-properties
 * intersection: the call signature handles `marker(':sel')` (one overload per
 * registered modifier-literal, plus a wide string fallback), and the `&`
 * clause attaches the anchor class and the underscore builder forms.
 *
 * Why a function-with-`&`-properties: TS infers the call signature from the
 * function half (so `marker(':hover')` narrows to the right overload) and
 * still resolves member access (`marker.anchor`, `marker._focus`) through
 * the intersected object type. This is the standard trick for a callable
 * object shape and is what TypeScript's own emit uses for hybrid types.
 */
function renderMarkerEntry(marker: RegisteredMarker): string {
  const propertyFields: string[] = [
    `      readonly anchor: ${JSON.stringify(marker.anchorClass)};`,
    ...MARKER_STATES.map((state) => renderUnderscoreBuilder(state, marker, /*indent*/ 6)),
  ];
  // Distinct call-form modifiers (the underscore builders already cover the
  // pseudo-class equivalents emitted by STATE_PSEUDO, so we don't repeat them).
  const builtinPseudos = new Set<string>(MARKER_STATES.map((s) => STATE_PSEUDO[s]));
  const callOverloads = Array.from(marker.relations.values())
    .map((rel) => rel.modifier)
    .filter((modifier, i, arr) => arr.indexOf(modifier) === i)
    .filter((modifier) => !builtinPseudos.has(modifier))
    .map((modifier) => renderCallOverload(modifier, marker, /*indent*/ 6));

  const objectShape = `{
${propertyFields.join("\n")}
    }`;
  // The function half. Empty when no call-form modifiers were registered;
  // we still emit a wide fallback so `m(':any')` is callable in source even
  // before the prescan has seen it (TS narrows to `string` rather than the
  // overload set, which is fine — the runtime synthesizes a working condition
  // from the inline FNV-1a hash so the call won't fail at runtime, just
  // won't have an emitted CSS rule until prescan picks the modifier up).
  const callShape = renderCallShape(callOverloads, marker);

  return `    ${JSON.stringify(marker.id)}: ${callShape} & ${objectShape};`;
}

function renderUnderscoreBuilder(
  state: MarkerState,
  marker: RegisteredMarker,
  indent: number,
): string {
  const pad = " ".repeat(indent);
  const modifier = STATE_PSEUDO[state];
  const ancestor = `_${buildRelationConditionName(marker.suffix, "ancestor", modifier)}`;
  const descendant = `_${buildRelationConditionName(marker.suffix, "descendant", modifier)}`;
  const sibling = `_${buildRelationConditionName(marker.suffix, "sibling", modifier)}`;
  return `${pad}readonly _${state}: { readonly is: { readonly ancestor: ${JSON.stringify(ancestor)}; readonly descendant: ${JSON.stringify(descendant)}; readonly sibling: ${JSON.stringify(sibling)} } };`;
}

function renderCallOverload(modifier: string, marker: RegisteredMarker, indent: number): string {
  const pad = " ".repeat(indent);
  const ancestor = `_${buildRelationConditionName(marker.suffix, "ancestor", modifier)}`;
  const descendant = `_${buildRelationConditionName(marker.suffix, "descendant", modifier)}`;
  const sibling = `_${buildRelationConditionName(marker.suffix, "sibling", modifier)}`;
  return `${pad}(selector: ${JSON.stringify(modifier)}): { readonly is: { readonly ancestor: ${JSON.stringify(ancestor)}; readonly descendant: ${JSON.stringify(descendant)}; readonly sibling: ${JSON.stringify(sibling)} } };`;
}

function renderCallShape(overloads: string[], marker: RegisteredMarker): string {
  // Always include a wide fallback overload after the registered literals.
  // It returns a template-literal-typed builder (parameterized by the same
  // suffix the synthesized record uses), so unregistered modifiers still
  // produce a string that's at least structurally inside the marker's
  // condition namespace. The codegen-patch separately widens the patched
  // `Conditions` to include those template-literal keys (see below).
  const wide = `      (selector: string): { readonly is: { readonly ancestor: \`_marker_${marker.suffix}_ancestor_\${string}\`; readonly descendant: \`_marker_${marker.suffix}_descendant_\${string}\`; readonly sibling: \`_marker_${marker.suffix}_sibling_\${string}\` } };`;
  const all = [...overloads, wide].join("\n");
  return `{
${all}
    }`;
}

/**
 * Render a `Conditions` interface augmentation that registers the open-set of
 * relational marker condition keys (`_marker_<suffix>_<rel>_<modhash>`) so
 * Panda's `keyof Conditions`-driven typing accepts them as computed-key
 * positions in `css({...})`. The literal keys for already-prescanned
 * modifiers are also covered by this template-literal slot, so when a user
 * adds a new `m(':never-seen').is.ancestor` call before `panda codegen`
 * re-runs, the type still accepts it — only the emitted CSS lags by one
 * codegen pass.
 */
function renderConditionsAugmentation(markers: readonly RegisteredMarker[]): string {
  if (markers.length === 0) return "";
  const entries: string[] = [];
  for (const marker of markers) {
    for (const rel of ["ancestor", "descendant", "sibling"] as const) {
      const literal = `\`_marker_${marker.suffix}_${rel}_\${string}\``;
      entries.push(`    [k: ${literal}]: string;`);
    }
  }
  return [
    "",
    "// --- Relational marker conditions: emitted by @bearbones/vite codegen:prepare ---",
    "// Open-set keys produced by `m(':sel').is.<relation>` chains. Each entry is",
    "// a template-literal index signature so `keyof Conditions` includes any",
    "// modifier hash a user might author, even before the prescan registers it.",
    "declare module '../types/conditions' {",
    "  interface Conditions {",
    entries.join("\n"),
    "  }",
    "}",
    "",
  ].join("\n");
}

void modifierHash; // re-exported by the registry; we only need the pre-hashed condition names

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
