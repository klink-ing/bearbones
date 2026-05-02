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
const STATE_PSEUDO: Record<MarkerState, string> = {
  hover: ":is(:hover, [data-hover])",
  focus: ":is(:focus, [data-focus])",
  focusVisible: ":focus-visible",
  active: ":is(:active, [data-active])",
  disabled: ":is(:disabled, [data-disabled])",
};

function shortHash(input: string): string {
  // 8 hex chars is sufficient to avoid collisions across realistic codebases
  // and keeps the generated class names short.
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
    for (const state of MARKER_STATES) {
      // Panda registers conditions WITHOUT leading underscores; the underscore
      // is added at lookup time when consumers write `_<name>` in css() calls.
      // Mismatching this strips the rule from the output silently.
      const conditionName = `marker${capitalize(state)}_${marker.suffix}`;
      const pseudo = STATE_PSEUDO[state];
      out[conditionName] = `.${marker.anchorClass}${pseudo} &`;
    }
  }
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Reset the registry. Used between tests; not part of the public surface.
 */
export function __resetRegistry(): void {
  MARKERS.clear();
}
