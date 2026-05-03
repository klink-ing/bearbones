import { createHash } from "node:crypto";

/**
 * Pure helpers used by the lowering transform to compose marker anchors and
 * relational raw selectors. There is no module-scoped state — `marker(id)`
 * declarations don't need to be "registered" anywhere; the transform derives
 * everything it needs (suffix, anchor class, raw selector) deterministically
 * from `(id, modulePath)` on demand.
 *
 * The condition vocabulary that drives the `_<name>` property-form shortcuts
 * lives in `conditions-stash.ts`, not here. This module only knows how to
 * compose a raw selector once a condition value has been resolved.
 */

export interface MarkerDescriptor {
  /** The literal id passed to `marker(...)`. */
  readonly id: string;
  /** The module path of the declaring file. */
  readonly modulePath: string;
  /** Module-scoped 8-hex SHA1 hash of `(id, modulePath)`. */
  readonly hash: string;
  /** Suffix applied to the anchor class (`bearbones-marker-<suffix>`). */
  readonly suffix: string;
  /** The class the parent applies to itself for relational anchoring. */
  readonly anchorClass: string;
}

type InterpolateParts<Parts extends readonly string[], T extends string> = Parts extends readonly [
  infer Only extends string,
]
  ? Only
  : Parts extends readonly [infer Head extends string, ...infer Tail extends readonly string[]]
    ? `${Head}${T}${InterpolateParts<Tail, T>}`
    : "";

/**
 * Maps each entry tuple in a tuple of `[name, ...]` entries to its name. The
 * generic parameter triggers TypeScript's homomorphic-tuple mapping so the
 * result is a precise tuple of names rather than a generic array.
 */
type EntryNames<Entries extends readonly (readonly [string, ...unknown[]])[]> = {
  [I in keyof Entries]: Entries[I] extends readonly [infer Name, ...unknown[]] ? Name : never;
};

/**
 * The raw-selector shapes a marker chain compiles to, expressed as `(name,
 * segments)` entries. The segments are the literal text surrounding the marker
 * observer at each interpolation point — the marker observer is the user's
 * condition value with every `&` already substituted for the marker's anchor
 * class. Each template wraps that observer in `:where(...)` so it contributes
 * zero specificity, mirroring StyleX's `when.*` API. The trailing `&` (or
 * `&:where(...)` self-nesting form) is Panda's placeholder for the styled
 * element — the only specificity contributor in the final rule after Panda's
 * `postcss-nested` flat-emit substitutes `&` for the styled class.
 *
 * The entries are written as a tuple so TypeScript preserves declaration
 * order; both `RELATION_SELECTORS` (the lookup record) and `MARKER_RELATIONS`
 * (the iteration tuple) are derived from this single source. Edit this table
 * when adding a relation or tuning a shape; nothing else in the package
 * hardcodes these strings.
 */
const RELATION_SELECTOR_ENTRIES = [
  ["ancestor", [":where(", ") &"]],
  ["descendant", ["&:where(:has(", "))"]],
  ["siblingBefore", [":where(", ") ~ &"]],
  ["siblingAfter", ["&:where(:has(~ ", "))"]],
  // Comma order is irrelevant to CSS but matters to TypeScript: the
  // template-literal type must satisfy Panda's `AnySelector`
  // (`${string}&` | `&${string}`), so put the `&`-prefixed branch first
  // so the result starts with `&`.
  ["siblingAny", ["&:where(:has(~ ", ")), :where(", ") ~ &"]],
] as const satisfies readonly (readonly [string, readonly [string, string, ...string[]]])[];

export const RELATION_SELECTORS = Object.fromEntries(RELATION_SELECTOR_ENTRIES) as {
  [E in (typeof RELATION_SELECTOR_ENTRIES)[number] as E[0]]: E[1];
};

export const MARKER_RELATIONS = RELATION_SELECTOR_ENTRIES.map(
  ([name]) => name,
) as unknown as EntryNames<typeof RELATION_SELECTOR_ENTRIES>;

export type MarkerRelation = (typeof MARKER_RELATIONS)[number];

export type RelationSelectors<T extends string> = {
  [R in keyof typeof RELATION_SELECTORS]: InterpolateParts<(typeof RELATION_SELECTORS)[R], T>;
};

export function applyRelationSelector<R extends MarkerRelation, T extends string>(
  relation: R,
  m: T,
): RelationSelectors<T>[R] {
  return RELATION_SELECTORS[relation].join(m) as RelationSelectors<T>[R];
}

/**
 * Compose all five raw-selector strings for a single substituted observer
 * `m`. Used both at build time (via `buildRelationSelector`) and at runtime
 * (via the inlined helper the transform prepends to marker-declaring files).
 * Single source of truth for the `is.<relation>` shape.
 */
export function composeRelationSelectors<T extends string>(m: T): RelationSelectors<T> {
  const out = {} as Partial<Record<MarkerRelation, string>>;
  for (const r of MARKER_RELATIONS) {
    out[r] = applyRelationSelector(r, m);
  }
  return out as RelationSelectors<T>;
}

/**
 * Recursive `&`-substitution at the type level: replace every `&` in `S`
 * with `Anchor`. Mirrors what `substituteAmp` does at runtime — together
 * they let us derive the type-level marker observer from the same shape
 * that the runtime emits.
 */
export type SubstituteAmp<
  S extends string,
  Anchor extends string,
> = S extends `${infer Pre}&${infer Post}` ? `${Pre}${Anchor}${SubstituteAmp<Post, Anchor>}` : S;

/**
 * Substitute every `&` in `s` with `anchor`. Strongly typed over both
 * arguments so callers (and the codegen-patch type emit) can derive the
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
 * Compose the marker anchor selector (`.bearbones-marker-<id>_<hash>`) from
 * id and hash. The codegen-patch's type emit calls
 * `ReturnType<typeof markerAnchor<Id, "<HASH>">>` to derive the type-level
 * anchor — the runtime substitutes a real 8-hex SHA1 hash, the type uses a
 * fixed `<HASH>` placeholder TypeScript can hold as a literal.
 */
export function markerAnchor<Id extends string, Hash extends string>(
  id: Id,
  hash: Hash,
): `.bearbones-marker-${Id}_${Hash}` {
  return `.bearbones-marker-${id}_${hash}`;
}

/**
 * Build-time SHA1-based hash for marker suffixes. Browser-safe is not a
 * requirement: the `(id, modulePath)` pair is only meaningful during the
 * build, and the hash output is baked into the synthesized marker record as
 * a literal.
 */
function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

/**
 * Compose a marker descriptor from `(id, modulePath)`. Pure function — no
 * caching, no global state. Callers that want to amortize the SHA1 hash
 * across many lookups can wrap this in their own `Map`.
 */
export function describeMarker(id: string, modulePath: string): MarkerDescriptor {
  const hash = shortHash(`${id}::${modulePath}`);
  const suffix = `${id}_${hash}`;
  return {
    id,
    modulePath,
    hash,
    suffix,
    anchorClass: `bearbones-marker-${suffix}`,
  };
}

/**
 * Compose the raw CSS selector for a `(condValue, relation)` pair anchored at
 * `anchorClass`. Pure — same inputs, same output.
 *
 * `condValue` is a Panda condition value verbatim — the same string the user
 * would put on the right side of a `conditions: { _foo: '<here>' }` entry.
 * Every `&` in the input is substituted with the marker's anchor selector
 * (`.bearbones-marker-<suffix>`); the result is then run through the
 * `RELATION_SELECTORS` template for the chosen relation, which wraps the
 * marker observation in `:where(...)` for zero specificity (mirroring
 * StyleX's `when.*` API). The trailing `&` (or `&:where(...)` self-nesting
 * form) refers to the *styled* element — Panda's normal placeholder, the
 * only specificity contributor in the emitted rule.
 *
 * Throws if `condValue` doesn't contain `&` — a relational marker query is
 * fundamentally about element relationships, and the placeholder is how we
 * say *which* element the marker is.
 */
export function buildRelationSelector(
  anchorClass: string,
  condValue: string,
  relation: MarkerRelation,
): string {
  if (!condValue.includes("&")) {
    throw new Error(
      `bearbones: marker() requires the '&' placeholder; got: ${JSON.stringify(condValue)}`,
    );
  }
  // Pipeline mirrors the type-level derivation in the codegen-patch:
  //   substituteAmp(condValue, "." + anchorClass) → m
  //   applyRelationSelector(relation, m) → final selector
  // The codegen-patch uses `ReturnType<typeof substituteAmp<...>>` and
  // `ReturnType<typeof composeRelationSelectors<...>>` to derive the
  // type-level shape from these same functions.
  const m = substituteAmp(condValue, `.${anchorClass}` as `.${typeof anchorClass}`);
  return applyRelationSelector(relation, m);
}
