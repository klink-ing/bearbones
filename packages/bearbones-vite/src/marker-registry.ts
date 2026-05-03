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

export type MarkerRelation = "ancestor" | "descendant" | "sibling";

export const MARKER_RELATIONS: readonly MarkerRelation[] = ["ancestor", "descendant", "sibling"];

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
 * (`.bearbones-marker-<suffix>`); the result is then wrapped in the relation:
 *
 *   ancestor   — `M &`
 *   descendant — `&:has(M)`
 *   sibling    — `& ~ M, M ~ &`
 *
 * The trailing `&` in the wrapped form refers to the *styled* element (Panda's
 * normal placeholder); the inner `&` was the marker (now substituted out).
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
  switch (relation) {
    case "ancestor":
      return `${m} &`;
    case "descendant":
      return `&:has(${m})`;
    case "sibling":
      return `& ~ ${m}, ${m} ~ &`;
  }
}
