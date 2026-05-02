/**
 * Public entry point for the `bearbones` package.
 *
 * The runtime surface here is intentionally minimal — Panda owns the heavy
 * lifting. We only ship:
 *
 *   - `cx`: a clsx-style class string joiner used to combine multiple class
 *     strings (the result of `css()`, recipe outputs, prop passthrough, etc.).
 *
 *   - `marker`: declares a typed marker symbol for parent-state styling.
 *     Lowered by `@bearbones/vite`'s parser:before transform into a
 *     synthesized object literal at build time.
 *
 *   - Type augmentation of Panda's `css()` signature happens in
 *     `@bearbones/vite`'s `codegen:prepare` hook, which patches Panda's
 *     emitted `styled-system/css/css.d.ts` directly. The patched file
 *     exports a project-accurate `BearbonesUtilityName` union derived
 *     from Panda's resolved tokens — import from there if you want to
 *     reference the union in your own code.
 *
 *   - Re-exports of `css`, `cva`, `sva` from the host project's
 *     `styled-system/` directory (Panda's generated runtime). At install time
 *     a tiny shim is wired up so `import { css } from 'bearbones'` resolves
 *     to the host's `styled-system/css`.
 *
 * Note on `css()` and friends: the actual runtime functions live in the host
 * project's `styled-system/` directory (Panda's codegen output). The bearbones
 * facade is a *type-erased* reference; the lowering transform in
 * `@bearbones/vite` rewrites `import { css } from 'bearbones'` → matching
 * Panda imports during the parser:before pass. (MVP simplification: this
 * rewrite is not yet implemented; consumers temporarily import `css` directly
 * from `styled-system/css`. Tracked in the design spec under "open questions:
 * facade rewriting.")
 *
 * The `cx` and `marker` exports are full runtime implementations and ship from
 * this package without any rewriting.
 */

/**
 * clsx-style class string concat. Loose by design — accepts arbitrary strings
 * and falsy values. The discipline lives at the `css()` boundary, not here.
 */
export function cx(...args: Array<string | false | null | undefined>): string {
  let out = "";
  for (const arg of args) {
    if (!arg) continue;
    if (out.length === 0) {
      out = arg;
    } else {
      out = out + " " + arg;
    }
  }
  return out;
}

/**
 * Runtime shape returned from `marker(...)` after the transform rewrites the
 * call site. Useful only as a TypeScript type — at runtime, the transform
 * replaces every `marker('id')` call with a synthesized object literal.
 *
 * If a consumer somehow imports `marker` directly without running through the
 * transform (e.g., an SSR runtime that didn't pre-build), this fallback
 * implementation throws. That's the loudest possible signal that the build
 * pipeline isn't wired correctly.
 *
 * The return type goes through `BearbonesMarkerRuntime<Id>`, which prefers
 * the project-specific entry from `BearbonesMarkerRegistry` (populated by
 * `@bearbones/vite`'s `codegen:prepare` hook from the prescan output) and
 * falls back to a wide template-literal shape for unregistered ids.
 *
 * The registered entry uses *literal* strings for every condition key
 * (`hover: '_markerHover_card_a27adb16'`), which lets `[cardMarker.hover]`
 * narrow to a specific `keyof Conditions` member at call sites — avoiding
 * the index-signature widening that template literals cause when used as
 * computed keys alongside other static keys.
 */
export function marker<Id extends string>(_id: Id): BearbonesMarkerRuntime<Id> {
  throw new Error(
    "bearbones: marker() was called at runtime. " +
      "This usually means the @bearbones/vite transform did not run before this module. " +
      "Verify Panda's hooks include bearbonesHooks() and that the file imports `marker` from 'bearbones'.",
  );
}

/**
 * Project-specific marker registry. Augmented at codegen time by
 * `@bearbones/vite` via a `declare module 'bearbones'` block emitted into
 * the patched `styled-system/css/css.d.ts`. The augmentation lists every
 * `marker(...)` declaration discovered during the prescan and assigns
 * literal-string condition keys derived from that marker's hashed suffix.
 *
 * The interface starts empty here so the package builds cleanly in
 * isolation; consumer projects pick up the populated version once their
 * Panda codegen has run.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented per-project
export interface BearbonesMarkerRegistry {}

/**
 * Public alias for the resolved marker shape. Looks up the project-specific
 * entry first, then falls back to the wide template-literal default for
 * unregistered ids (e.g., during the first dev-server render before
 * `panda codegen` has run, or for marker declarations whose containing
 * file isn't in Panda's `include` glob).
 */
export type BearbonesMarkerRuntime<Id extends string = string> =
  Id extends keyof BearbonesMarkerRegistry
    ? BearbonesMarkerRegistry[Id]
    : DefaultBearbonesMarker<Id>;

/**
 * The relational builder returned from a marker call (`m(':sel')`) or an
 * underscore shortcut (`m._hover`). `.is.<relation>` resolves to a Panda
 * condition key that targets the styled element when an `ancestor`,
 * `descendant`, or `sibling` of the marker anchor matches the modifier.
 *
 * For unregistered marker ids, the literal condition keys aren't known yet,
 * so we widen with `${string}` template literals. Once the codegen patch has
 * emitted `BearbonesMarkerRegistry[Id]` (after the prescan), consumers see
 * the precise literals.
 */
export interface DefaultBearbonesMarkerBuilder<Id extends string> {
  readonly is: {
    readonly ancestor: `_marker_${Id}_${string}_ancestor_${string}`;
    readonly descendant: `_marker_${Id}_${string}_descendant_${string}`;
    readonly sibling: `_marker_${Id}_${string}_sibling_${string}`;
  };
}

export interface DefaultBearbonesMarker<Id extends string = string> {
  readonly anchor: string;
  // Existing shortcuts (no change). Each is the Panda condition key for the
  // element being styled when an ancestor with this marker is in that state.
  readonly hover: `_markerHover_${Id}_${string}`;
  readonly focus: `_markerFocus_${Id}_${string}`;
  readonly active: `_markerActive_${Id}_${string}`;
  readonly focusVisible: `_markerFocusVisible_${Id}_${string}`;
  readonly disabled: `_markerDisabled_${Id}_${string}`;
  // Underscore builder form: each yields an `.is.{ancestor,descendant,sibling}`
  // chain that lets consumers pick the relation explicitly.
  readonly _hover: DefaultBearbonesMarkerBuilder<Id>;
  readonly _focus: DefaultBearbonesMarkerBuilder<Id>;
  readonly _active: DefaultBearbonesMarkerBuilder<Id>;
  readonly _focusVisible: DefaultBearbonesMarkerBuilder<Id>;
  readonly _disabled: DefaultBearbonesMarkerBuilder<Id>;
  /**
   * Call form: pass an arbitrary CSS-fragment modifier (e.g. `:has(.error)`,
   * `[data-state=open]`, `:focus-within`) and pick a relation via `.is`.
   * The `@bearbones/vite` prescan must see the modifier as a string literal
   * so it can register a Panda condition for it; dynamic strings will land
   * at runtime as keys for unregistered conditions and produce no CSS.
   */
  (selector: string): DefaultBearbonesMarkerBuilder<Id>;
}

// Note: `BearbonesUtilityName` is no longer re-exported from this package.
// The closed set of valid utility names is derived from the host project's
// resolved Panda tokens at codegen time, so the only project-accurate
// version of the type lives in the patched `styled-system/css/css.d.ts`:
//
//   import type { BearbonesUtilityName } from '../styled-system/css';
//
// The `css()` function itself doesn't need this import — utility strings are
// accepted natively at the call site via the same patch.
