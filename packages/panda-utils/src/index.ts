/**
 * Shared utilities for the @klinking/panda-* plugin packages.
 *
 * Two layers live here:
 *
 *   1. Generic TS helpers (`substituteAmp`, `deepAssign`, `shortHash`, plus the
 *      type-level pieces) — operate on string-typed templates with literal-type
 *      precision so plugins can derive the substituted/interpolated literal
 *      from the function's `ReturnType<typeof fn<...>>`. That round-trip is
 *      what lets `@klinking/panda-markers`' codegen-patch emit a host-readable
 *      `css.d.ts` whose marker types evaluate to the exact runtime selectors.
 *
 *   2. Codegen-patch + transform infrastructure (re-exported below) — the AST
 *      anchor locator, the contributor-style css.d.ts/css.mjs patch applier,
 *      the parser-import discovery, and the template fence stripper.
 *
 * Build-time helpers (the `inline-templates` Vite plugin) live on the `./build`
 * subpath, not here, so consumer Panda hooks don't accidentally drag rolldown
 * plugin types into their bundle.
 */

import { createHash } from "node:crypto";

/**
 * Recursive template-literal interpolation. Joins each segment in `Parts`
 * with `T` interpolated between consecutive segments. Mirrors the runtime
 * `parts.join(T)` shape with literal-type precision.
 *
 * Example:
 *   InterpolateParts<[":where(", ") &"], ".x:hover">
 *     → ":where(.x:hover) &"
 *
 *   InterpolateParts<["&:where(:has(~ ", ")), :where(", ") ~ &"], ".x:hover">
 *     → "&:where(:has(~ .x:hover)), :where(.x:hover) ~ &"
 */
export type InterpolateParts<
  Parts extends readonly string[],
  T extends string,
> = Parts extends readonly [infer Only extends string]
  ? Only
  : Parts extends readonly [infer Head extends string, ...infer Tail extends readonly string[]]
    ? `${Head}${T}${InterpolateParts<Tail, T>}`
    : "";

/**
 * Map a tuple of `[name, ...]` entries to a tuple of just the names. The
 * homomorphic mapping (`{ [I in keyof Entries]: ... }`) preserves the input
 * tuple's length and order in the result type, so callers like
 * `MARKER_RELATIONS = ENTRIES.map(([n]) => n) as EntryNames<typeof ENTRIES>`
 * get a precisely-typed tuple instead of a generic `string[]`.
 */
export type EntryNames<Entries extends readonly (readonly [string, ...unknown[]])[]> = {
  [I in keyof Entries]: Entries[I] extends readonly [infer Name, ...unknown[]] ? Name : never;
};

/**
 * Recursive `&`-substitution at the type level: replace every `&` in `S`
 * with `Anchor`. Mirrors what `substituteAmp` does at runtime — together
 * they let downstream code derive substituted literals from the runtime
 * function's return type.
 */
export type SubstituteAmp<
  S extends string,
  Anchor extends string,
> = S extends `${infer Pre}&${infer Post}` ? `${Pre}${Anchor}${SubstituteAmp<Post, Anchor>}` : S;

/**
 * Substitute every `&` in `s` with `anchor`. Strongly typed over both
 * arguments so callers (and downstream type emit) can derive the
 * substituted literal from the function's return type via
 * `ReturnType<typeof substituteAmp<S, Anchor>>`.
 */
export function substituteAmp<S extends string, Anchor extends string>(
  s: S,
  anchor: Anchor,
): SubstituteAmp<S, Anchor> {
  return s.split("&").join(anchor) as SubstituteAmp<S, Anchor>;
}

/**
 * Recursive deep-merge of two plain-object trees. Later writes win at
 * leaves; nested objects are merged recursively. Arrays are treated as
 * leaves (replaced wholesale, not concatenated). Mutates `target` in
 * place — caller controls whether to copy first.
 *
 * Generic over `Record<string, unknown>` so it composes with any plain-
 * object shape (style fragments, token trees, config blobs).
 */
export function deepAssign(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(source)) {
    const existing = target[k];
    if (
      existing != null &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      v != null &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      deepAssign(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}

/**
 * Build-time short hash (8-hex SHA1) over a string. Browser-safe is not a
 * goal — the call site is in Node-side tooling. Used by bearbones to
 * derive stable suffixes for marker anchor classes from `(id, modulePath)`.
 *
 * SHA1 is fine here: collision-resistance isn't a security requirement,
 * just a "different inputs produce different outputs with very high
 * probability" guarantee for build-time identifiers.
 */
export function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

// Codegen-patch infrastructure consumed by @klinking/panda-markers and
// @klinking/panda-shorthand's `codegen:prepare` hooks.
export { locateCssDtsAnchors, type CssDtsAnchors } from "./codegen-patch-ast.ts";
export {
  applyCssDtsPatches,
  applyCssMjsPatches,
  patchPandaArtifacts,
  type CssDtsPatch,
  type CssMjsPatch,
  type ArtifactPatchContributor,
  type PandaArtifact,
  type PandaArtifactFile,
  type PandaArtifactId,
} from "./codegen-patch.ts";
export { loadTemplateBody, TEMPLATE_FENCE, type TemplateLoader } from "./codegen-templates.ts";

// Transform skeleton — the AST walk + bearbones-import-discovery boilerplate
// that both plugins build their own per-feature lowering on top of.
export {
  emptyBindings,
  findStyledSystemImports,
  isStyledSystemSource,
  literalStringArg,
  parseSource,
  trackReBindings,
  walk,
  type ImportBindings,
} from "./transform-helpers.ts";
