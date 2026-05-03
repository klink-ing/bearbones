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

export const MARKER_RELATIONS = [
  "ancestor",
  "descendant",
  "siblingBefore",
  "siblingAfter",
  "siblingAny",
] as const;

export type MarkerRelation = (typeof MARKER_RELATIONS)[number];

/**
 * The five raw-selector shapes a marker chain compiles to. The argument is
 * the marker observer — the user's condition value with every `&` already
 * substituted for the marker's anchor class. Each template wraps that
 * observer in `:where(...)` so it contributes zero specificity, mirroring
 * StyleX's `when.*` API. The trailing `&` (or `&:where(...)` self-nesting
 * form) is Panda's placeholder for the styled element — the only specificity
 * contributor in the final rule after Panda's `postcss-nested` flat-emit
 * substitutes `&` for the styled class.
 *
 * Edit this table when adding a relation or tuning a shape; nothing else in
 * the package hardcodes these strings. The transform's inline runtime helper
 * derives its bodies from this same table via `composeRelationSelectors`.
 */
export const RELATION_SELECTORS = {
  ancestor: <T extends string>(m: T) => `:where(${m}) &` as const,
  descendant: <T extends string>(m: T) => `&:where(:has(${m}))` as const,
  siblingBefore: <T extends string>(m: T) => `:where(${m}) ~ &` as const,
  siblingAfter: <T extends string>(m: T) => `&:where(:has(~ ${m}))` as const,
  // Comma order is irrelevant to CSS but matters to TypeScript: the
  // template-literal type must satisfy Panda's `AnySelector`
  // (`${string}&` | `&${string}`), so put the `&`-prefixed branch first
  // so the result starts with `&`.
  siblingAny: <T extends string>(m: T) => `&:where(:has(~ ${m})), :where(${m}) ~ &` as const,
} as const satisfies Record<MarkerRelation, (m: string) => string>;

/**
 * Compose all five raw-selector strings for a single substituted observer
 * `m`. Used both at build time (via `buildRelationSelector`) and at runtime
 * (via the inlined helper the transform prepends to marker-declaring files).
 * Single source of truth for the `is.<relation>` shape.
 */
export function composeRelationSelectors(m: string): Record<MarkerRelation, string> {
  const out = {} as Record<MarkerRelation, string>;
  for (const r of MARKER_RELATIONS) out[r] = RELATION_SELECTORS[r](m);
  return out;
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
  const m = condValue.replaceAll("&", `.${anchorClass}`);
  return RELATION_SELECTORS[relation](m);
}
