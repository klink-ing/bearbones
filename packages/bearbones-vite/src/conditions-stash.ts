import { preset as pandaPreset } from "@pandacss/preset-base";

/**
 * Module-scoped stash of the host project's resolved Panda condition values.
 *
 * Populated from `config.conditions` in the `config:resolved` hook (see
 * `index.ts`). Until that hook fires we fall back to the conditions shipped by
 * `@pandacss/preset-base` so unit tests that bypass the hook pipeline still
 * see the standard `_hover`/`_focus`/etc. vocabulary.
 *
 * Values are stored under keys with any leading `_` stripped, so users can
 * write `m._hover` regardless of whether the source preset declared the
 * condition as `hover` (preset-base style) or `_hover` (typical user style).
 *
 * Only string condition values are kept — at-rule conditions and structured
 * tokens are out of scope for relational marker chains, which require an `&`
 * placeholder to compose against the marker's anchor class.
 */

let CONDITIONS: Record<string, string> = loadFallbackConditions();

/**
 * Strip a single leading `_` from a condition key so user-written `_dark`,
 * preset-base `hover`, and codegen-emitted `_focusVisible` all hash to the
 * same lookup name.
 */
export function normalizeConditionName(key: string): string {
  return key.startsWith("_") ? key.slice(1) : key;
}

function loadFallbackConditions(): Record<string, string> {
  const out: Record<string, string> = {};
  const conditions = (pandaPreset as { conditions?: Record<string, unknown> }).conditions;
  if (!conditions || typeof conditions !== "object") return out;
  for (const [key, value] of Object.entries(conditions)) {
    if (typeof value !== "string") continue;
    out[normalizeConditionName(key)] = value;
  }
  return out;
}

/**
 * Replace the stash with the host project's resolved conditions. Called once
 * per `config:resolved` from the bearbones hook.
 */
export function setConditions(conditions: Record<string, unknown>): void {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(conditions)) {
    if (typeof value !== "string") continue;
    next[normalizeConditionName(key)] = value;
  }
  CONDITIONS = next;
}

/**
 * Look up a condition value by normalized name (no leading `_`). Returns
 * `undefined` if the condition isn't registered.
 */
export function getCondition(name: string): string | undefined {
  return CONDITIONS[normalizeConditionName(name)];
}

/**
 * Snapshot of every condition name with a string value. Consumed by
 * `codegen-patch.ts` to enumerate `_<name>` shortcuts on the project-local
 * `BearbonesMarker<Id>` interface.
 *
 * Filtered to entries whose value contains the `&` placeholder — bare
 * at-rule conditions (`@media (...)`, `@container (...)`) can't compose into
 * a relational marker query and are skipped from the type surface.
 */
export function listConditionsWithAnchor(): readonly { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(CONDITIONS)) {
    if (!value.includes("&")) continue;
    out.push({ name, value });
  }
  return out;
}

/**
 * Serialize the stash for cross-process hand-off (Panda extraction process →
 * Vite dev-server process). Mirrors `serializeUtilityMap` in `utility-map.ts`.
 */
export function serializeConditions(): string {
  return JSON.stringify(CONDITIONS);
}

export function hydrateConditions(json: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") next[key] = value;
  }
  CONDITIONS = next;
}
