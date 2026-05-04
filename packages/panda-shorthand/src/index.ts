/**
 * Public entry point for `@klinking/panda-shorthand`.
 *
 * Ships four shapes — pick whichever matches your `panda.config.ts`
 * conventions:
 *
 *   1. `shorthandPreset()` — a Panda preset (no hooks, just the
 *      meta-information Panda's preset machinery understands). Add it to
 *      `presets:`. Pairs with `shorthandPlugin()` for the hook side.
 *
 *   2. `shorthandPlugin()` — a named Panda plugin built via Panda's
 *      `definePlugin()`, bundling the `config:resolved` + `parser:before`
 *      + `codegen:prepare` hooks. Add it to `plugins:` (Panda's hook
 *      sharing API; see https://panda-css.com/docs/concepts/hooks#sharing-hooks).
 *
 *   3. `shorthandHooks()` — the raw hooks object for users who hand-wire
 *      `hooks: { ...shorthandHooks() }` instead of using the plugin.
 *
 *   4. `shorthandVitePlugin()` — the dev-server transform. Required so
 *      runtime `css('p-4')` calls are lowered before the browser sees
 *      them; without it the browser receives raw utility strings and
 *      Panda's runtime can't resolve them.
 *
 * See the README for `panda.config.ts` and `vite.config.ts` snippets.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { definePlugin } from "@pandacss/dev";
import { patchPandaArtifacts, type PandaArtifact } from "@klinking/panda-utils";
import { transform } from "./transform.ts";
import { shorthandPatchContributor } from "./codegen-patch.ts";
import {
  hydrateUtilityMap,
  populateUtilityMapFromTokens,
  serializeUtilityMap,
} from "./utility-map.ts";

// Inferred from `definePlugin` directly. Importing `PandaPlugin` from
// `@pandacss/types` would drag pkg-types into the dts bundle, where TS6
// trips on pkg-types' `import { CompilerOptions } from 'typescript'`
// (missing `type` modifier — known pkg-types bug).
type PandaPluginValue = ReturnType<typeof definePlugin>;

/**
 * Cross-process hand-off path. Panda's extraction runs in one process
 * (`panda --watch`); the dev-server lowering runs in another (`vp dev`).
 * They don't share memory, so the Panda-side `config:resolved` hook
 * serializes the populated utility map to this file and the Vite-side
 * `configResolved` hook hydrates from it.
 */
const UTILITY_MAP_CACHE_REL_PATH = "node_modules/.cache/klinking-panda-shorthand/utility-map.json";

function cachePath(cwd: string, rel: string): string {
  return resolvePath(cwd, rel);
}

function writeCache(cwd: string, rel: string, contents: string): void {
  const path = cachePath(cwd, rel);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  } catch {
    // Best-effort: a write failure here means the Vite plugin won't see
    // the map and runtime behavior will degrade. Surfacing as a hard error
    // blocks the entire build for what's a dev-mode optimization.
  }
}

function readCache(cwd: string, rel: string, hydrate: (json: string) => void): void {
  const path = cachePath(cwd, rel);
  try {
    const json = readFileSync(path, "utf8");
    hydrate(json);
  } catch {
    // Cache absent on first dev-server start before Panda has run.
  }
}

export interface ShorthandHooksOptions {
  /** Reserved for future verbose-logging knobs. Currently unused. */
  verbose?: boolean;
}

/**
 * Build the shared hook bodies. Used by both `shorthandHooks()` (which
 * returns the raw object) and `shorthandPlugin()` (which wraps it via
 * Panda's `definePlugin`). Single source of truth.
 */
function buildHooks() {
  return {
    "config:resolved": ({ config }: { config: any }) => {
      populateUtilityMapFromTokens(config.theme?.tokens);
      const cwd = (config.cwd as string | undefined) ?? process.cwd();
      writeCache(cwd, UTILITY_MAP_CACHE_REL_PATH, serializeUtilityMap());
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
    "codegen:prepare": ({ artifacts }: { artifacts: PandaArtifact[] }): PandaArtifact[] => {
      return patchPandaArtifacts(artifacts, shorthandPatchContributor);
    },
  };
}

/**
 * Raw hooks object — for users who hand-wire `hooks: { ...shorthandHooks() }`
 * directly. Panda's recommended approach is to use `shorthandPlugin()` instead;
 * this is here for symmetry and tests.
 */
export function shorthandHooks(_options: ShorthandHooksOptions = {}) {
  return buildHooks();
}

/**
 * Named Panda plugin (definePlugin). Add to `plugins: [shorthandPlugin()]`
 * in `panda.config.ts`.
 */
export function shorthandPlugin(_options: ShorthandHooksOptions = {}): PandaPluginValue {
  return definePlugin({
    name: "@klinking/panda-shorthand",
    hooks: buildHooks() as any,
  });
}

/**
 * Empty Panda preset — placeholder so users can write
 * `presets: [shorthandPreset(), markersPreset()]` symmetrically with the
 * markers plugin (which has real condition contributions). Currently
 * contributes no theme/conditions/utilities; the work happens via the
 * plugin's hooks. Returning a preset here means the API stays stable when
 * shorthand picks up token defaults or condition contributions later.
 */
export function shorthandPreset(_options: ShorthandHooksOptions = {}) {
  return {
    name: "@klinking/panda-shorthand",
  };
}

export default shorthandPlugin;

export interface ShorthandVitePluginOptions {
  // Glob options retained for API compatibility; unused now that the
  // lowering transform is fully self-contained per file.
  include?: readonly string[];
  exclude?: readonly string[];
}

/**
 * Vite plugin that runs the shorthand lowering transform on every TSX/TS
 * module before it's delivered to the browser.
 */
export function shorthandVitePlugin(_options: ShorthandVitePluginOptions = {}): {
  name: string;
  enforce: "pre";
  configResolved: (config: { root: string }) => void;
  transform: (code: string, id: string) => { code: string; map: null } | null;
} {
  let cwd = process.cwd();
  let hydrated = false;
  return {
    name: "klinking-panda-shorthand",
    enforce: "pre",
    configResolved(config: { root: string }) {
      cwd = config.root;
      readCache(cwd, UTILITY_MAP_CACHE_REL_PATH, hydrateUtilityMap);
      hydrated = true;
    },
    transform(code: string, id: string) {
      if (!/\.(?:tsx?|jsx?|mts|cts|mtsx?|ctsx?)$/.test(id)) return null;
      if (!hydrated) {
        readCache(cwd, UTILITY_MAP_CACHE_REL_PATH, hydrateUtilityMap);
        hydrated = true;
      }
      const result = transform({ filePath: id, source: code });
      if (result.content === undefined) return null;
      return { code: result.content, map: null };
    },
  };
}

// Re-export internal pieces consumed by tests + advanced wiring.
export {
  hydrateUtilityMap,
  listUtilities,
  populateUtilityMapFromTokens,
  serializeUtilityMap,
} from "./utility-map.ts";
export { transform } from "./transform.ts";
export { buildCssDtsPatches, shorthandPatchContributor } from "./codegen-patch.ts";
