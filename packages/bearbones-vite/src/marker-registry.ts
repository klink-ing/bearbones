import { createHash } from "node:crypto";

/**
 * Pure helpers used by the lowering transform to compose marker anchors and
 * relational raw selectors. There is no module-scoped state — `marker(id)`
 * declarations don't need to be "registered" anywhere; the transform derives
 * everything it needs (suffix, anchor class, raw selector) deterministically
 * from `(id, modulePath)` on demand.
 *
 * That deterministic derivation is the whole reason this module exists.
 * Anything that needs a stable build-time identity for `(id, modulePath)`
 * — the synthesized record's anchor class, cross-file lookups in the
 * transform — calls into here and gets the same answer every time.
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

/**
 * Standard set of pseudo-states each marker exposes as a typed `_<state>`
 * builder shortcut on the synthesized record. The shortcut is equivalent to
 * calling the marker with the matching `STATE_PSEUDO[state]` selector.
 */
export const MARKER_STATES = ["hover", "focus", "focusVisible", "active", "disabled"] as const;

export type MarkerState = (typeof MARKER_STATES)[number];

/**
 * Map a state name to the CSS pseudo-class that selects it on the anchor.
 * Mirrors the selectors Panda's preset-base uses for `_hover` etc.
 */
export const STATE_PSEUDO: Record<MarkerState, string> = {
  hover: ":is(:hover, [data-hover])",
  focus: ":is(:focus, [data-focus])",
  focusVisible: ":focus-visible",
  active: ":is(:active, [data-active])",
  disabled: ":is(:disabled, [data-disabled])",
};

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
 * Compose the raw CSS selector for a `(modifier, relation)` pair anchored at
 * `anchorClass`. Pure — same inputs, same output. Used by both the build-time
 * lowering and the runtime helper baked into the synthesized marker record,
 * so they produce identical strings.
 *
 * Selectors:
 *   ancestor   — `<anchor><modifier> &`
 *   descendant — `&:has(<anchor><modifier>)`
 *   sibling    — `& ~ <anchor><modifier>, <anchor><modifier> ~ &`
 *
 * Sibling is comma-emitted starting with `&` so the resulting string matches
 * Panda's `AnySelector` (`&${string}`) on the type side. Ordering of
 * comma-joined selectors is irrelevant to emitted CSS.
 *
 * All three match Panda's `parseCondition` at runtime (`endsWith(" &")`,
 * `startsWith("&")`, `includes("&")`), so Panda treats them as raw selectors
 * at extraction time without any condition having to be pre-registered.
 */
export function buildRelationSelector(
  anchorClass: string,
  modifier: string,
  relation: MarkerRelation,
): string {
  const anchor = `.${anchorClass}${modifier}`;
  switch (relation) {
    case "ancestor":
      return `${anchor} &`;
    case "descendant":
      return `&:has(${anchor})`;
    case "sibling":
      return `& ~ ${anchor}, ${anchor} ~ &`;
  }
}
