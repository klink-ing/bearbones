import { createHash } from "node:crypto";

/**
 * The global marker registry tracks every `marker(<id>)` declaration discovered
 * during the parser:before pass across the codebase.
 *
 * A marker's identity is the (id, modulePath) pair: distinct files declaring
 * `marker('card')` get distinct hashed anchor classes, so two unrelated
 * components don't accidentally share a marker.
 *
 * Why a registry at all when we no longer register Panda conditions: the
 * codegen-patch's `BearbonesMarkerRegistry` augmentation lists every marker
 * declaration the project contains, and the cross-file lookup in
 * `transform.ts` relies on a stable `(id, modulePath) → suffix` map.
 */

export interface RegisteredMarker {
  /** The literal id passed to `marker(...)`. */
  readonly id: string;
  /** The module path where the declaration lives. Used for the hash. */
  readonly modulePath: string;
  /** Module-scoped hash; combined with id to make the suffix. */
  readonly hash: string;
  /** Suffix applied to the anchor class (`bearbones-marker-<suffix>`). */
  readonly suffix: string;
  /** The class the parent applies to itself for relational anchoring. */
  readonly anchorClass: string;
}

const MARKERS = new Map<string, RegisteredMarker>();

/**
 * Standard set of pseudo-states each declared marker exposes as a typed
 * `_<state>` builder shortcut on the synthesized record. The shortcut is
 * equivalent to calling the marker with the matching `STATE_PSEUDO[state]`
 * selector — the runtime path collapses both forms to the same raw selector.
 */
export const MARKER_STATES = ["hover", "focus", "focusVisible", "active", "disabled"] as const;

export type MarkerState = (typeof MARKER_STATES)[number];

/**
 * Map a state name to the CSS pseudo-class that selects it on the anchor.
 * Mirrors the selectors Panda's preset-base uses for `_hover` etc., so the
 * resulting rules feel consistent with Panda's defaults.
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

function key(id: string, modulePath: string): string {
  return `${id}::${modulePath}`;
}

export function registerMarker(id: string, modulePath: string): RegisteredMarker {
  const k = key(id, modulePath);
  const cached = MARKERS.get(k);
  if (cached) return cached;
  const hash = shortHash(k);
  const suffix = `${id}_${hash}`;
  const registered: RegisteredMarker = {
    id,
    modulePath,
    hash,
    suffix,
    anchorClass: `bearbones-marker-${suffix}`,
  };
  MARKERS.set(k, registered);
  return registered;
}

export function listMarkers(): readonly RegisteredMarker[] {
  return Array.from(MARKERS.values());
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

/**
 * Reset the registry. Used between tests; not part of the public surface.
 */
export function __resetRegistry(): void {
  MARKERS.clear();
}
