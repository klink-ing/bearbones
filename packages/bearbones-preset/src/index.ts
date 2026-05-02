import { definePreset } from "@pandacss/dev";

/**
 * Stable conditions registered by bearbones beyond Panda's preset-base defaults.
 *
 * Marker conditions (`_markerHover_<id>_<hash>`, etc.) are NOT defined here —
 * they are registered dynamically by `@bearbones/vite` as it discovers
 * `marker()` declarations during the parser:before pass.
 */
const STATIC_CONDITIONS = {
  // Color scheme — preset-base ships `_dark` already, but we re-declare for
  // documentation and to anchor the bearbones contract.
  _dark: ".dark &, [data-theme='dark'] &",
  _light: ".light &, [data-theme='light'] &",
} as const;

export interface BearbonesPresetOptions {
  /**
   * When true, includes a CSS reset under `@layer base`. Defaults to true.
   * Set to false if you ship your own reset.
   */
  preflight?: boolean;
}

/**
 * The bearbones Panda preset. Pulled into a Panda config via
 * `presets: [bearbonesPreset()]`.
 *
 * MVP behavior:
 * - Re-uses Panda's preset-base for tokens and the bulk of utility shorthands.
 *   (Panda already implements a Tailwind-flavored token grid and utility
 *   property names.)
 * - Registers bearbones-specific conditions on top.
 *
 * Future work tracked in the design spec:
 * - Drop preset-base entirely and ship a Tailwind v4 native token grid.
 * - Add a Preflight reset matching Tailwind v4 (currently relies on
 *   Panda's built-in preflight).
 */
export function bearbonesPreset(_options: BearbonesPresetOptions = {}) {
  return definePreset({
    name: "@bearbones/preset",
    conditions: {
      extend: {
        ...STATIC_CONDITIONS,
      },
    },
  });
}

export default bearbonesPreset;
