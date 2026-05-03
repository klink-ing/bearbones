/**
 * Generic TypeScript utilities used across the bearbones packages.
 *
 * The shared theme is "operate on string-typed templates with literal-type
 * precision": each runtime helper here has a paired type-level alias so
 * callers can derive the substituted/interpolated literal from the
 * function's `ReturnType<typeof fn<...>>`. That round-trip is what lets
 * `@bearbones/vite`'s codegen-patch emit a host-readable `css.d.ts`
 * whose marker types evaluate to the exact runtime selector strings.
 */

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
