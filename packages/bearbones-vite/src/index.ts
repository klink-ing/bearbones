/**
 * Public entry point for `@bearbones/vite`.
 *
 * This module ships two integration points that work together:
 *
 *   1. `bearbonesHooks()` — Panda hooks (`config:resolved` + `parser:before`
 *      + `codegen:prepare`) that lower utility strings + marker symbols when
 *      Panda extracts CSS, and patch the emitted `css()` type signature so
 *      the host project's `css()` import accepts utility strings natively.
 *
 *   2. `bearbonesVitePlugin()` — a Vite plugin that runs the SAME lowering
 *      on every `.ts/.tsx` file before it reaches the browser. Without this,
 *      the dev server would ship the original `css('p-4', ...)` call sites
 *      to the browser, and Panda's runtime `css()` would receive utility
 *      strings it doesn't understand (returning empty or invalid classes).
 *
 * Both layers share a single `transform()` implementation, so behavior is
 * consistent between the static extraction and the runtime JS.
 *
 *   import { defineConfig } from '@pandacss/dev';
 *   import { bearbonesPreset } from '@bearbones/preset';
 *   import { bearbonesHooks } from '@bearbones/vite';
 *
 *   export default defineConfig({
 *     presets: [bearbonesPreset()],
 *     hooks: bearbonesHooks(),
 *   });
 *
 *   // vite.config.ts
 *   import { defineConfig } from 'vite';
 *   import react from '@vitejs/plugin-react';
 *   import { bearbonesVitePlugin } from '@bearbones/vite';
 *
 *   export default defineConfig({
 *     plugins: [bearbonesVitePlugin(), react()],
 *   });
 */

import { transform } from "./transform.ts";
import { patchArtifacts, type PandaArtifact } from "./codegen-patch.ts";
import { populateUtilityMapFromTokens } from "./utility-map.ts";

export interface BearbonesHooksOptions {
  /**
   * If true (default), surface a verbose log line each time the parser:before
   * hook rewrites a file. Useful while tracking down extraction issues; turn
   * off in production builds.
   */
  verbose?: boolean;
}

/**
 * Return a Panda hooks object that wires bearbones into Panda's pipeline.
 *
 * Hooks set:
 *   - `config:resolved` — populates the utility-string lookup table from the
 *     host project's resolved Panda tokens.
 *
 *   - `parser:before` — rewrites `marker()` declarations and lowers `css()`,
 *     `cva()`, `sva()` argument shapes into Panda's native form. Relational
 *     marker chains (`m(':sel').is.<rel>`, `m._<state>.is.<rel>`) are lowered
 *     to *raw selector* keys (`.bearbones-marker-<suffix><modifier> &` etc.),
 *     which Panda's parser recognizes natively as parent-/self-/combinator-
 *     nesting selectors — no condition registration needed.
 *
 *   - `codegen:prepare` — patches Panda's emitted `styled-system/css/css.d.ts`
 *     in memory before it's written to disk, widening the `css()` signature
 *     to accept bearbones utility strings. See `codegen-patch.ts` for the
 *     patch shape and rationale.
 */
export function bearbonesHooks(_options: BearbonesHooksOptions = {}) {
  return {
    "config:resolved": ({ config }: { config: any }) => {
      // Populate the utility-string lookup table from the host project's
      // resolved Panda tokens. After this runs, every utility-shorthand
      // (`p-{spacing}`, `bg-{color-shade}`, `text-{fontSize}`, …) reflects
      // the actual tokens available in the project — no manual scale arrays.
      populateUtilityMapFromTokens(config.theme?.tokens);
    },
    "parser:before": ({
      filePath,
      content,
    }: {
      filePath: string;
      content: string;
    }): string | void => {
      const result = transform({ filePath, source: content });
      if (result.content === undefined) return;
      return result.content;
    },
    // Mirrors the existing pattern of `config:resolved` (which takes
    // `config: any`): we keep the public hook signature loosely typed and
    // strict-type the internal logic via `PandaArtifact`. Importing
    // @pandacss/types here would drag pkg-types → typescript transitive
    // imports into the rolldown bundle.
    "codegen:prepare": ({ artifacts }: { artifacts: PandaArtifact[] }): PandaArtifact[] => {
      return patchArtifacts(artifacts);
    },
  };
}

export default bearbonesHooks;

/**
 * Vite plugin that runs the bearbones lowering transform on every TSX/TS
 * module before it's delivered to the browser.
 *
 * This is required for dev-server and SSR runtime behavior. Static CSS
 * extraction is handled by `bearbonesHooks()` plugged into Panda's config;
 * this plugin handles the JS side so runtime `css('p-4', ...)` calls are
 * actually rewritten to `css({ p: '4' }, ...)` before they reach Panda's
 * runtime helper.
 */
export interface BearbonesVitePluginOptions {
  // Glob options retained for API compatibility; no longer used now that the
  // lowering transform is fully self-contained per file (no global prescan).
  include?: readonly string[];
  exclude?: readonly string[];
}

export function bearbonesVitePlugin(_options: BearbonesVitePluginOptions = {}): {
  name: string;
  enforce: "pre";
  transform: (code: string, id: string) => { code: string; map: null } | null;
} {
  return {
    name: "bearbones",
    // Run before other plugins so the lowered source is what react/jsx and
    // panda's own Vite plugin see.
    enforce: "pre",
    transform(code: string, id: string) {
      // Vite passes the file's full URL/path; ignore non-source-file ids.
      if (!/\.(?:tsx?|jsx?|mts|cts|mtsx?|ctsx?)$/.test(id)) return null;
      const result = transform({ filePath: id, source: code });
      if (result.content === undefined) return null;
      return { code: result.content, map: null };
    },
  };
}

// Re-export internal pieces that the test suite consumes.
export { listUtilities, populateUtilityMapFromTokens } from "./utility-map.ts";
// Expose the codegen patch helpers for tests / advanced wiring.
export { patchCssArtifact, patchArtifacts } from "./codegen-patch.ts";
export type { PandaArtifact, PandaArtifactFile } from "./codegen-patch.ts";

// NOTE: `BearbonesUtilityName` is no longer re-exported as a static type.
// The set of valid utility names is now derived from the host project's
// resolved Panda tokens at runtime; the only authoritative type union is
// the one emitted into the patched `css.d.ts` by `codegen-patch.ts`.
// Consumers wanting a typed utility-name union should import it from there:
//
//   import type { BearbonesUtilityName } from '../styled-system/css';
