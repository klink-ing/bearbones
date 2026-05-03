import { preset as pandaPreset } from "@pandacss/preset-base";

/**
 * Module-scoped stash of the host project's resolved Panda condition values.
 *
 * Populated from `config.conditions` in the `config:resolved` hook (see
 * `index.ts`). Until that hook fires we fall back to the conditions shipped
 * by `@pandacss/preset-base` so unit tests that bypass the hook pipeline
 * still see the standard `hover`/`focus`/etc. vocabulary.
 *
 * Keys are stored exactly as Panda emits them. Panda's resolved
 * `config.conditions` always uses the unprefixed form (`hover`, `dark`,
 * `myCustomCond`) — the leading-`_` you write in `panda.config.ts` is
 * stripped during resolution. The user-facing API exposes them through
 * `marker._<name>`, and the transform slices the leading `_` before
 * looking up here, so the round-trip stays consistent without any
 * normalization step on this side.
 *
 * Only string condition values are kept — at-rule conditions and structured
 * tokens are out of scope for relational marker chains, which require an `&`
 * placeholder to compose against the marker's anchor class.
 */

let CONDITIONS: Record<string, string> = loadFallbackConditions();

function loadFallbackConditions(): Record<string, string> {
  const out: Record<string, string> = {};
  const conditions = (pandaPreset as { conditions?: Record<string, unknown> }).conditions;
  if (!conditions || typeof conditions !== "object") return out;
  for (const [key, value] of Object.entries(conditions)) {
    if (typeof value !== "string") continue;
    out[key] = value;
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
    next[key] = value;
  }
  CONDITIONS = next;
}

/**
 * Look up a condition value by name (e.g. `hover`, `dark`). The transform
 * passes in the stripped form of `m._<name>`. Returns `undefined` if the
 * condition isn't registered.
 */
export function getCondition(name: string): string | undefined {
  return CONDITIONS[name];
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
