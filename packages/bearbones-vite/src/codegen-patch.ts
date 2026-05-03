/**
 * Patch Panda's emitted `styled-system/css/` artifacts so the project-local
 * `css()` import is the single source of truth for bearbones primitives:
 *
 *   - `css.d.ts` — widens the `css()` signature to accept bearbones utility
 *     strings, and injects the project-local `marker()` declaration plus its
 *     `BearbonesMarker<Id>` / `BearbonesMarkerBuilder<Id>` interfaces. The
 *     `_<name>` shortcut per registered Panda condition is enumerated from
 *     the conditions stash so users get autocomplete for their full
 *     vocabulary, including any extensions.
 *
 *   - `css.mjs` — injects a runtime stub for `marker()` that throws with a
 *     diagnostic message if it ever runs unrewritten. Panda already ships
 *     `cx` in the same artifact (re-exported from `styled-system/css/cx`),
 *     so users get all four primitives — `css`, `cva`/`sva` (via recipes),
 *     `cx`, `marker` — from one import path.
 *
 * Wired into Panda's `codegen:prepare` hook in `index.ts`. Runs once per
 * codegen pass, after `config:resolved` (so the conditions stash is
 * populated) and immediately before Panda writes any artifact to disk.
 *
 * Strategy: locate Panda's `type Styles = ...` line by exact-match anchor and
 * rewrite it to point at a widened type tree (`BearbonesSystemStyleObject`)
 * defined inline above. The widened tree mirrors Panda's own `Nested<P>`
 * structure. If Panda's emitted format ever changes such that the anchor
 * isn't found, the patch throws a recognizable error rather than silently
 * producing wrong types.
 */

import { listConditionsWithAnchor } from "./conditions-stash.ts";
import { listUtilities } from "./utility-map.ts";

/**
 * The anchor we replace in Panda's emitted `css.d.ts`.
 */
const STYLES_ANCHOR = "type Styles = SystemStyleObject | undefined | null | false";

/**
 * Sentinel comment we drop into the runtime artifact so a re-patch (e.g. on
 * Panda's watch-mode codegen) doesn't append a second copy of the marker
 * stub.
 */
const RUNTIME_PATCH_SENTINEL = "/* @bearbones/vite: marker stub */";

/**
 * Patch the source of `styled-system/css/css.d.ts`. Returns the patched
 * source string. Pure function — no I/O, no side effects.
 *
 * Throws if the source doesn't contain the expected anchor.
 */
export function patchCssArtifact(
  source: string,
  utilityNames: readonly string[],
  conditions: readonly { name: string; value: string }[],
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
  const markerTypes = renderMarkerTypes(conditions);
  const patchedStyles = "type Styles = BearbonesSystemStyleObject | undefined | null | false";

  const importBlock = renderImportBlock();
  const pandaImportMarker = "import type { SystemStyleObject } from '../types/index';";
  if (!source.includes(pandaImportMarker)) {
    throw new Error(
      `@bearbones/vite codegen-patch: expected Panda import marker not found.\n` +
        `Marker: ${JSON.stringify(pandaImportMarker)}\n` +
        `If Panda changed how it imports SystemStyleObject, update the marker ` +
        `in packages/bearbones-vite/src/codegen-patch.ts.`,
    );
  }

  return source
    .replace(pandaImportMarker, `${pandaImportMarker}\n${importBlock}\n${injectedTypes}`)
    .replace(STYLES_ANCHOR, `${patchedStyles}\n\n${markerTypes}`);
}

/**
 * Patch `styled-system/css/css.mjs` to add the `marker()` runtime stub. The
 * stub throws if it ever executes — when the bearbones transform has run on
 * a file, every `marker('id')` call site has been rewritten to a synthesized
 * literal record, so the runtime stub only fires as a misconfiguration alarm.
 *
 * Idempotent: if the stub is already present (sentinel comment match), we
 * return the input unchanged. Panda's watch-mode regenerates `css.mjs`
 * fresh on each pass so this idempotency is belt-and-suspenders only.
 */
export function patchCssRuntime(source: string): string {
  if (source.includes(RUNTIME_PATCH_SENTINEL)) return source;
  const stub = [
    "",
    RUNTIME_PATCH_SENTINEL,
    "export function marker(_id) {",
    "  throw new Error(",
    '    "bearbones: marker() was called at runtime. " +',
    '      "This usually means the @bearbones/vite transform did not run before this module. " +',
    "      \"Verify Panda's hooks include bearbonesHooks() and that the file imports `marker` from 'styled-system/css'.\"",
    "  );",
    "}",
    "",
  ].join("\n");
  return source.endsWith("\n") ? source + stub : source + "\n" + stub;
}

/**
 * Convenience wrapper that patches against the live utility list and
 * conditions stash. Used by the `codegen:prepare` hook in production; tests
 * pass fixed inputs to keep snapshots stable.
 */
export function patchCssArtifactLive(source: string): string {
  return patchCssArtifact(source, listUtilities(), listConditionsWithAnchor());
}

function renderUtilityUnion(names: readonly string[]): string {
  if (names.length === 0) return "never";
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
 * Project-local `marker` declaration + supporting interfaces.
 *
 * The `_<name>` shortcuts are enumerated from the conditions stash so the
 * surface tracks the host project's full condition vocabulary, including
 * presets it pulls in and any user `extend` entries. Conditions whose value
 * lacks the `&` placeholder are omitted at the stash level (see
 * `conditions-stash.ts`); the type emit only sees keys that compose into a
 * relational marker query.
 *
 * Relation result types are *real selector shapes* — `:where(<observer>) &`
 * for ancestor, etc. — with the `<observer>` slot computed by recursively
 * substituting every `&` in the condition value with the marker's anchor
 * selector. The five relations match StyleX's `when.*` API and produce
 * specificity (0,1,0) at runtime: only the styled element's own class
 * counts, not the marker observation.
 *
 * The hash slot in the anchor (`.bearbones-marker-${Id}_<HASH>`) is a fixed
 * literal placeholder. TypeScript can't compute the runtime SHA1 hash, so
 * the type-level selector and runtime selector match in shape but differ
 * in that one slot. Keeping the hash as a literal placeholder (rather than
 * `${string}`) is what lets these computed-key types survive in `css({...})`
 * arguments without collapsing into a string-index signature on the
 * enclosing object — a collapse that would conflict with Panda's narrow
 * property indexes the moment a sibling literal property is added.
 *
 * The fully-resolved selectors satisfy `AnySelector` (each contains `&`),
 * so they're accepted as keys in `BearbonesNestedObject<P>` via the
 * `[K in AnySelector]?` index. The runtime transform substitutes the real
 * hashed selector at parser:before time.
 */
function renderMarkerTypes(conditions: readonly { name: string; value: string }[]): string {
  const shortcutLines = conditions.map(
    ({ name, value }) =>
      `  readonly ${quoteIdentifierIfNeeded(`_${name}`)}: BearbonesMarkerBuilder<Id, ${JSON.stringify(value)}>;`,
  );
  return [
    "// Marker selector shapes are derived from the return types of the runtime",
    "// functions in `@bearbones/vite/marker-registry`, so the type-level",
    "// evaluation of `marker(...).is.<relation>` matches the runtime emit",
    "// byte-for-byte (modulo the build-time SHA1 hash, which TypeScript can't",
    "// compute — we substitute a fixed `<HASH>` literal placeholder there).",
    "import type {",
    "  composeRelationSelectors,",
    "  markerAnchor,",
    "  markerAnchorClass,",
    "  substituteAmp,",
    "} from '@bearbones/vite';",
    "",
    "/** Anchor selector for the marker; `<HASH>` is the type-level placeholder. */",
    "type BearbonesMarkerAnchor<Id extends string> = ReturnType<",
    '  typeof markerAnchor<Id, "<HASH>">',
    ">;",
    "",
    "/** Marker observation: condition value with every `&` substituted for the anchor. */",
    "type BearbonesObserver<Id extends string, Cond extends string> = ReturnType<",
    "  typeof substituteAmp<Cond, BearbonesMarkerAnchor<Id>>",
    ">;",
    "",
    "export interface BearbonesMarkerBuilder<Id extends string, Cond extends string> {",
    "  readonly is: ReturnType<typeof composeRelationSelectors<BearbonesObserver<Id, Cond>>>;",
    "}",
    "",
    "export interface BearbonesMarker<Id extends string = string> {",
    // Anchor class derived from `markerAnchorClass`'s return type so the
    // host-visible class name shape always matches what `describeMarker`
    // produces at runtime. The `string` second arg stands in for the
    // unknown SHA1 hash slot — TypeScript can't compute the hash, so we
    // intentionally widen here (the consumer reads this as a className
    // string, not as a computed key, so widening is fine).
    "  readonly anchor: ReturnType<typeof markerAnchorClass<Id, string>>;",
    ...shortcutLines,
    // Call form: `Cond` is inferred from the literal arg so each distinct
    // call site gets a distinct concrete observer. Non-literal args widen
    // to `string` and the resulting selector type loses concreteness —
    // that aligns with the runtime contract since the lowering transform
    // only resolves literal arguments anyway.
    "  <C extends string>(condValue: C): BearbonesMarkerBuilder<Id, C>;",
    "}",
    "",
    "export declare function marker<Id extends string>(id: Id): BearbonesMarker<Id>;",
    "",
  ].join("\n");
}

/**
 * Property-key syntax helper. JS identifiers don't allow `-` or other punctuation,
 * so condition names like `my-cond` produce property keys that need quoting.
 */
function quoteIdentifierIfNeeded(name: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return name;
  return JSON.stringify(name);
}

/**
 * Patch a Panda `Artifact[]` array in-place by finding the `css-fn` artifact's
 * `css.d.ts` and `css.mjs` files and rewriting their `code`. Used by the
 * `codegen:prepare` hook.
 */
export function patchArtifacts(artifacts: PandaArtifact[]): PandaArtifact[] {
  return artifacts.map((artifact) => {
    if (artifact.id !== "css-fn") return artifact;
    return {
      ...artifact,
      files: artifact.files.map((file) => {
        if (file.code === undefined) return file;
        if (file.file === "css.d.ts") {
          return { ...file, code: patchCssArtifactLive(file.code) };
        }
        if (file.file === "css.mjs") {
          return { ...file, code: patchCssRuntime(file.code) };
        }
        return file;
      }),
    };
  });
}

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
