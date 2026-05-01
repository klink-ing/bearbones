import { createHash } from "node:crypto";

/**
 * The global group registry tracks every `group(<id>)` declaration discovered
 * during the parser:before pass across the codebase.
 *
 * A group's identity is the (id, modulePath) pair: distinct files declaring
 * `group('card')` get distinct hashed condition names, so two unrelated
 * components don't accidentally share a group.
 *
 * The registry survives across files within a single Panda build because Panda
 * invokes `parser:before` once per file, but the same hooks instance is reused
 * for the whole build. This lets us:
 *   1. Discover groups during the parser pass.
 *   2. Surface their conditions through `config:resolved` (which runs before
 *      any parsing, so groups discovered earlier are already registered when
 *      the next file is parsed).
 *
 * MVP simplification: groups are registered eagerly the first time they are
 * seen, but Panda's `config:resolved` hook only fires once at startup. To
 * sidestep this for the spike, we use a hardcoded list of standard group
 * states and pre-register all five for every group as soon as it's seen. A
 * more sophisticated codegen-based registration is tracked in the spec.
 */

export interface RegisteredGroup {
  /** The literal id passed to `group(...)`. */
  readonly id: string;
  /** The module path where the declaration lives. Used for the hash. */
  readonly modulePath: string;
  /** Module-scoped hash; combined with id to make the condition suffix. */
  readonly hash: string;
  /** Suffix applied to all condition names for this group. */
  readonly suffix: string;
  /** The class the parent applies to itself. */
  readonly anchorClass: string;
}

const GROUPS = new Map<string, RegisteredGroup>();

/**
 * Standard set of states each declared group registers as conditions.
 * Mirrors the `BearbonesGroup<Id>` interface in the design spec.
 */
export const GROUP_STATES = ["hover", "focus", "focusVisible", "active", "disabled"] as const;

export type GroupState = (typeof GROUP_STATES)[number];

/**
 * Map a state name to the CSS pseudo-class that selects it on the anchor.
 * Mirrors the selectors Panda's preset-base uses for `_groupHover` etc., so
 * the resulting rules feel consistent with Panda's defaults.
 */
const STATE_PSEUDO: Record<GroupState, string> = {
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

export function registerGroup(id: string, modulePath: string): RegisteredGroup {
  const k = key(id, modulePath);
  const cached = GROUPS.get(k);
  if (cached) return cached;
  const hash = shortHash(k);
  const suffix = `${id}_${hash}`;
  const registered: RegisteredGroup = {
    id,
    modulePath,
    hash,
    suffix,
    anchorClass: `bearbones-group-${suffix}`,
  };
  GROUPS.set(k, registered);
  return registered;
}

export function listGroups(): readonly RegisteredGroup[] {
  return Array.from(GROUPS.values());
}

/**
 * Build the conditions object Panda expects from the current registered
 * groups. Called by the `config:resolved` hook so every discovered group is
 * available to the extractor.
 *
 * Limitation noted in the spec: groups discovered during a build (after
 * `config:resolved` already ran) are registered with conditions that exist
 * "after the fact". The CSS extractor honors them because Panda re-resolves
 * conditions on each `parser:after`. For the MVP, the integration test
 * verifies this works end-to-end; a more rigorous codegen-driven registration
 * is future work.
 */
export function buildGroupConditions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const group of GROUPS.values()) {
    for (const state of GROUP_STATES) {
      // Panda registers conditions WITHOUT leading underscores; the underscore
      // is added at lookup time when consumers write `_<name>` in css() calls.
      // Mismatching this strips the rule from the output silently.
      const conditionName = `group${capitalize(state)}_${group.suffix}`;
      const pseudo = STATE_PSEUDO[state];
      out[conditionName] = `.${group.anchorClass}${pseudo} &`;
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
  GROUPS.clear();
}
