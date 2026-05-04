import { definePreset } from "@pandacss/dev";

/**
 * Stable conditions registered by the markers plugin beyond Panda's
 * preset-base defaults. These were previously contributed by the (now
 * deleted) `@bearbones/preset` package; folded in here so a single
 * `markersPreset()` call wires up everything the markers feature needs.
 *
 * Marker-anchored conditions are NOT defined here — the lowering
 * transform composes those on demand from `(anchorClass, condValue,
 * relation)` triples.
 */
const STATIC_CONDITIONS = {
  // Color scheme — preset-base ships `_dark` already; we re-declare for
  // documentation and to anchor the contract.
  _dark: ".dark &, [data-theme='dark'] &",
  _light: ".light &, [data-theme='light'] &",
} as const;

export interface MarkersPresetOptions {
  /** Reserved for future preflight/reset toggles. Currently unused. */
  preflight?: boolean;
}

/**
 * Panda preset for the markers plugin. Add to `presets:` in
 * `panda.config.ts`. Pairs with `markersPlugin()` (which carries the
 * hooks) for the full integration.
 */
export function markersPreset(_options: MarkersPresetOptions = {}) {
  return definePreset({
    name: "@klinking/panda-markers",
    conditions: {
      extend: {
        ...STATIC_CONDITIONS,
      },
    },
  });
}
