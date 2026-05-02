import { createHash } from "node:crypto";

/**
 * The global marker registry tracks every `marker(<id>)` declaration discovered
 * during the parser:before pass across the codebase.
 *
 * A marker's identity is the (id, modulePath) pair: distinct files declaring
 * `marker('card')` get distinct hashed condition names, so two unrelated
 * components don't accidentally share a marker.
 *
 * The registry survives across files within a single Panda build because Panda
 * invokes `parser:before` once per file, but the same hooks instance is reused
 * for the whole build. This lets us:
 *   1. Discover markers during the parser pass.
 *   2. Surface their conditions through `config:resolved` (which runs before
 *      any parsing, so markers discovered earlier are already registered when
 *      the next file is parsed).
 *
 * MVP simplification: markers are registered eagerly the first time they are
 * seen, but Panda's `config:resolved` hook only fires once at startup. To
 * sidestep this for the spike, we use a hardcoded list of standard marker
 * states and pre-register all five for every marker as soon as it's seen. A
 * more sophisticated codegen-based registration is tracked in the spec.
 */

export type MarkerRelation = "ancestor" | "descendant" | "sibling";

export const MARKER_RELATIONS: readonly MarkerRelation[] = ["ancestor", "descendant", "sibling"];

export interface RegisteredMarker {
  /** The literal id passed to `marker(...)`. */
  readonly id: string;
  /** The module path where the declaration lives. Used for the hash. */
  readonly modulePath: string;
  /** Module-scoped hash; combined with id to make the condition suffix. */
  readonly hash: string;
  /** Suffix applied to all condition names for this marker. */
  readonly suffix: string;
  /** The class the parent applies to itself. */
  readonly anchorClass: string;
  /**
   * (modifier, relation) pairs discovered at usage sites — `m(':sel').is.ancestor`
   * and `m._<state>.is.<relation>` chains. Keyed by condition name (without
   * leading underscore) so duplicates collapse cheaply.
   */
  readonly relations: Map<string, RegisteredRelation>;
}

export interface RegisteredRelation {
  /** Modifier string as authored (e.g., `:has(.foo)`, `:focus-within`). */
  readonly modifier: string;
  /** ancestor / descendant / sibling. */
  readonly relation: MarkerRelation;
  /** The Panda selector this condition expands to (with `&` for the styled element). */
  readonly selector: string;
}

const MARKERS = new Map<string, RegisteredMarker>();

/**
 * Standard set of states each declared marker registers as conditions.
 * Mirrors the `BearbonesMarker<Id>` interface in the design spec.
 */
export const MARKER_STATES = ["hover", "focus", "focusVisible", "active", "disabled"] as const;

export type MarkerState = (typeof MARKER_STATES)[number];

/**
 * Map a state name to the CSS pseudo-class that selects it on the anchor.
 * Mirrors the selectors Panda's preset-base uses for `_groupHover` etc., so
 * the resulting rules feel consistent with Panda's defaults.
 */
export const STATE_PSEUDO: Record<MarkerState, string> = {
  hover: ":is(:hover, [data-hover])",
  focus: ":is(:focus, [data-focus])",
  focusVisible: ":focus-visible",
  active: ":is(:active, [data-active])",
  disabled: ":is(:disabled, [data-disabled])",
};

/**
 * Build-time SHA1-based hash for marker suffixes. Not used at runtime — the
 * `(id, modulePath)` pair is only meaningful during the build, and a stable
 * 8-char hash from `node:crypto` is cheap and well-tested. Don't conflate with
 * `modifierHash` below, which must be computable in the browser.
 */
function shortHash(input: string): string {
  // 8 hex chars is sufficient to avoid collisions across realistic codebases
  // and keeps the generated class names short.
  return createHash("sha1").update(input).digest("hex").slice(0, 8);
}

/**
 * Pure-JS FNV-1a (32-bit) hash → 8 hex chars. Used to fingerprint modifier
 * strings for `marker(':sel').is.<relation>` condition names. The same
 * implementation is inlined into the synthesized marker record by the
 * transform, so build-side condition names match runtime-computed names
 * byte-for-byte. If you change the algorithm here, change the inlined copy in
 * `transform.ts` too — they MUST agree.
 */
export function modifierHash(input: string): string {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 0x01000193) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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
    relations: new Map(),
  };
  MARKERS.set(k, registered);
  return registered;
}

/**
 * Build the Panda selector for a (modifier, relation) pair anchored at
 * `anchorClass`. Pure function — same inputs, same output, used by both
 * `registerMarkerCondition` and the codegen-patch's selector-emission tests.
 *
 * Selectors:
 *   ancestor   — `<anchor><modifier> &`
 *   descendant — `&:has(<anchor><modifier>)`
 *   sibling    — `<anchor><modifier> ~ &, & ~ <anchor><modifier>`
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
      return `${anchor} ~ &, & ~ ${anchor}`;
  }
}

/**
 * Build the Panda condition name for a (marker, relation, modifier) triple.
 * Names are deterministic and underscore-less per Panda convention; the
 * leading `_` is added at lookup time when consumers write `_<name>` in css()
 * calls.
 */
export function buildRelationConditionName(
  suffix: string,
  relation: MarkerRelation,
  modifier: string,
): string {
  return `marker_${suffix}_${relation}_${modifierHash(modifier)}`;
}

/**
 * Register a (modifier, relation) pair against an existing or newly-created
 * marker. Idempotent: identical inputs collapse to the same condition entry.
 *
 * Throws on hash collision — two different modifier strings producing the
 * same `modifierHash` under the same `(marker, relation)`. The 32-bit FNV-1a
 * namespace gives this a vanishingly small probability per real codebase, but
 * the assertion catches deliberate adversarial cases at registration time
 * with both inputs named.
 */
export function registerMarkerCondition(
  id: string,
  modulePath: string,
  modifier: string,
  relation: MarkerRelation,
): { conditionName: string } {
  const m = registerMarker(id, modulePath);
  const conditionName = buildRelationConditionName(m.suffix, relation, modifier);
  const existing = m.relations.get(conditionName);
  if (existing) {
    if (existing.modifier !== modifier) {
      throw new Error(
        `bearbones: modifier hash collision for marker "${m.id}" relation "${relation}".\n` +
          `  Existing modifier: ${JSON.stringify(existing.modifier)}\n` +
          `  New modifier:      ${JSON.stringify(modifier)}\n` +
          `Both hashed to ${conditionName}. Pick a different selector form.`,
      );
    }
    return { conditionName };
  }
  m.relations.set(conditionName, {
    modifier,
    relation,
    selector: buildRelationSelector(m.anchorClass, modifier, relation),
  });
  return { conditionName };
}

export function listMarkers(): readonly RegisteredMarker[] {
  return Array.from(MARKERS.values());
}

/**
 * Build the conditions object Panda expects from the current registered
 * markers. Called by the `config:resolved` hook so every discovered marker is
 * available to the extractor.
 *
 * Limitation noted in the spec: markers discovered during a build (after
 * `config:resolved` already ran) are registered with conditions that exist
 * "after the fact". The CSS extractor honors them because Panda re-resolves
 * conditions on each `parser:after`. For the MVP, the integration test
 * verifies this works end-to-end; a more rigorous codegen-driven registration
 * is future work.
 */
export function buildMarkerConditions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const marker of MARKERS.values()) {
    for (const [conditionName, rel] of marker.relations) {
      out[conditionName] = rel.selector;
    }
  }
  return out;
}

/**
 * Reset the registry. Used between tests; not part of the public surface.
 */
export function __resetRegistry(): void {
  MARKERS.clear();
}
