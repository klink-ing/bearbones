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
 *   - Type-only re-export of `BearbonesUtilityName` from `@bearbones/vite`.
 *     The actual augmentation of Panda's `css()` signature happens in
 *     `@bearbones/vite`'s `codegen:prepare` hook, which patches Panda's
 *     emitted `styled-system/css/css.d.ts` directly.
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
 */
export function marker<Id extends string>(_id: Id): BearbonesMarkerRuntime<Id> {
  throw new Error(
    "bearbones: marker() was called at runtime. " +
      "This usually means the @bearbones/vite transform did not run before this module. " +
      "Verify Panda's hooks include bearbonesHooks() and that the file imports `marker` from 'bearbones'.",
  );
}

export interface BearbonesMarkerRuntime<Id extends string = string> {
  readonly anchor: string;
  readonly hover: `_markerHover_${Id}_${string}`;
  readonly focus: `_markerFocus_${Id}_${string}`;
  readonly active: `_markerActive_${Id}_${string}`;
  readonly focusVisible: `_markerFocusVisible_${Id}_${string}`;
  readonly disabled: `_markerDisabled_${Id}_${string}`;
}

/**
 * The closed union of every utility-string name accepted by `css()`.
 * Re-exported from `@bearbones/vite` where the source-of-truth scales live.
 *
 * Useful for typing your own helper functions that pass utility names through
 * to `css()`. The `css()` function itself doesn't need this type imported —
 * the `codegen:prepare` hook in `@bearbones/vite` patches Panda's emitted
 * `css.d.ts` so utility strings are accepted natively at the call site.
 */
export type { BearbonesUtilityName } from "@bearbones/vite";
