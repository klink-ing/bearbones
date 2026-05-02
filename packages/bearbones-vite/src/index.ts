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
import { buildMarkerConditions } from "./marker-registry.ts";
import { prescanMarkers } from "./prescan.ts";
import { patchArtifacts, type PandaArtifact } from "./codegen-patch.ts";

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
 *   - `parser:before` — rewrites `marker()` declarations and lowers `css()`,
 *     `cva()`, `sva()` argument shapes into Panda's native form. After this
 *     hook returns, Panda's extractor parses normalized source as if it were
 *     authored that way directly.
 *
 *   - `config:resolved` — registers the conditions for every marker discovered
 *     so far. Because `config:resolved` fires once at startup before any
 *     parsing, this is also re-invoked through Panda's config-change
 *     mechanism on rebuilds; new markers added during a session take effect
 *     after the next parser pass completes.
 *
 *   - `codegen:prepare` — patches Panda's emitted `styled-system/css/css.d.ts`
 *     in memory before it's written to disk, widening the `css()` signature
 *     to accept bearbones utility strings. See `codegen-patch.ts` for the
 *     patch shape and rationale.
 */
export function bearbonesHooks(_options: BearbonesHooksOptions = {}) {
  return {
    "config:resolved": ({ config }: { config: any }) => {
      // Pre-scan every included file for `marker()` declarations so the
      // resulting condition set is present in the config before Panda's
      // extractor runs.
      const cwd = config.cwd ?? process.cwd();
      const include = (config.include as string[] | undefined) ?? [];
      const exclude = (config.exclude as string[] | undefined) ?? [];
      if (include.length > 0) {
        prescanMarkers({ cwd, include, exclude });
      }
      const conditions = buildMarkerConditions();
      if (Object.keys(conditions).length === 0) return;
      // Panda's resolved config already flattened `extend` blocks before this
      // hook fires, so merging into `extend` again wraps the conditions in a
      // sub-object that the resolver mistakes for a nested condition group
      // (and then crashes calling `.startsWith` on the object). Merge into
      // the top-level conditions map instead.
      config.conditions = { ...config.conditions, ...conditions };
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
  /**
   * Glob patterns mirrored from your Panda config's `include`. Used by the
   * plugin's pre-scan to discover `marker()` declarations across the project
   * before the first module is transformed. Defaults to a sensible mirror
   * of `./src/**\/*.{ts,tsx}` if not provided.
   */
  include?: readonly string[];
  exclude?: readonly string[];
}

export function bearbonesVitePlugin(options: BearbonesVitePluginOptions = {}): {
  name: string;
  enforce: "pre";
  configResolved: (config: { root: string }) => void;
  transform: (code: string, id: string) => { code: string; map: null } | null;
} {
  let prescanned = false;
  return {
    name: "bearbones",
    // Run before other plugins so the lowered source is what react/jsx and
    // panda's own Vite plugin see.
    enforce: "pre",
    configResolved(config: { root: string }) {
      if (prescanned) return;
      prescanned = true;
      const include = options.include ?? ["./src/**/*.{ts,tsx}"];
      const exclude = options.exclude ?? [];
      prescanMarkers({ cwd: config.root, include, exclude });
    },
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
export { listMarkers } from "./marker-registry.ts";
export { listUtilities } from "./utility-map.ts";
// Re-export the derived utility-name union so consumers (and the `bearbones`
// facade) can use it for typing their own helpers. The closed-set version
// also lands in the patched `css.d.ts` via `codegen-patch.ts`.
export type { BearbonesUtilityName } from "./utility-map.ts";
// Expose the codegen patch helpers for tests / advanced wiring.
export { patchCssArtifact, patchArtifacts } from "./codegen-patch.ts";
export type { PandaArtifact, PandaArtifactFile } from "./codegen-patch.ts";
