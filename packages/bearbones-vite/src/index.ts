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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { transform } from "./transform.ts";
import { patchArtifacts, type PandaArtifact } from "./codegen-patch.ts";
import {
  hydrateUtilityMap,
  populateUtilityMapFromTokens,
  serializeUtilityMap,
} from "./utility-map.ts";
import { hydrateConditions, serializeConditions, setConditions } from "./conditions-stash.ts";

/**
 * Cross-process hand-off paths.
 *
 * Panda's extraction runs in one process (`panda --watch`); the dev-server
 * lowering runs in another (`vp dev`). They don't share memory, so the
 * Panda-side `config:resolved` hook serializes the populated maps to these
 * files and the Vite-side `configResolved` hook hydrates from them.
 */
const UTILITY_MAP_CACHE_REL_PATH = "node_modules/.cache/bearbones/utility-map.json";
const CONDITIONS_CACHE_REL_PATH = "node_modules/.cache/bearbones/conditions.json";

function cachePath(cwd: string, rel: string): string {
  return resolvePath(cwd, rel);
}

function writeCache(cwd: string, rel: string, contents: string): void {
  const path = cachePath(cwd, rel);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  } catch {
    // Best-effort: a write failure here just means the Vite plugin won't
    // see the map and runtime behavior will degrade. Surfacing as a hard
    // error blocks the entire build for what's a dev-mode optimization, so
    // we swallow and let downstream symptoms be the signal.
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

function writeBuildCaches(cwd: string): void {
  writeCache(cwd, UTILITY_MAP_CACHE_REL_PATH, serializeUtilityMap());
  writeCache(cwd, CONDITIONS_CACHE_REL_PATH, serializeConditions());
}

function readBuildCaches(cwd: string): void {
  readCache(cwd, UTILITY_MAP_CACHE_REL_PATH, hydrateUtilityMap);
  readCache(cwd, CONDITIONS_CACHE_REL_PATH, hydrateConditions);
}

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
      // Stash the resolved Panda conditions. The transform's relational
      // marker chains read property-form values (`m._hover`, `m._dark`,
      // `m._myCustomCond`) from this stash, and the codegen-patch
      // enumerates `_<name>` shortcuts on `BearbonesMarker<Id>` from the
      // same source.
      if (config.conditions && typeof config.conditions === "object") {
        setConditions(config.conditions as Record<string, unknown>);
      }
      // Write populated maps to cross-process caches so the Vite plugin
      // (running in a separate `vp dev` process) can hydrate from the same
      // vocabulary.
      const cwd = (config.cwd as string | undefined) ?? process.cwd();
      writeBuildCaches(cwd);
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
  configResolved: (config: { root: string }) => void;
  transform: (code: string, id: string) => { code: string; map: null } | null;
} {
  let cwd = process.cwd();
  let hydrated = false;
  return {
    name: "bearbones",
    // Run before other plugins so the lowered source is what react/jsx and
    // panda's own Vite plugin see.
    enforce: "pre",
    configResolved(config: { root: string }) {
      cwd = config.root;
      readBuildCaches(cwd);
      hydrated = true;
    },
    transform(code: string, id: string) {
      // Vite passes the file's full URL/path; ignore non-source-file ids.
      if (!/\.(?:tsx?|jsx?|mts|cts|mtsx?|ctsx?)$/.test(id)) return null;
      // First-transform fallback: if `panda --watch` started after
      // `vp dev`'s `configResolved` ran, the cache file may not have
      // existed yet. Try once on first transform call.
      if (!hydrated) {
        readBuildCaches(cwd);
        hydrated = true;
      }
      const result = transform({ filePath: id, source: code });
      if (result.content === undefined) return null;
      return { code: result.content, map: null };
    },
  };
}

// Re-export internal pieces that the test suite consumes.
export {
  hydrateUtilityMap,
  listUtilities,
  populateUtilityMapFromTokens,
  serializeUtilityMap,
} from "./utility-map.ts";
export {
  hydrateConditions,
  serializeConditions,
  setConditions,
  listConditionsWithAnchor,
} from "./conditions-stash.ts";
export { transform } from "./transform.ts";
// Expose the codegen patch helpers for tests / advanced wiring.
export { patchCssArtifact, patchCssRuntime, patchArtifacts } from "./codegen-patch.ts";
export type { PandaArtifact, PandaArtifactFile } from "./codegen-patch.ts";
// Marker primitives. The codegen-patch's emitted `BearbonesMarkerBuilder`
// types are derived from the return types of these functions so the
// type-level evaluation matches the runtime emit byte-for-byte (modulo the
// build-time hash, which TypeScript can't compute and substitutes with a
// fixed `<HASH>` placeholder).
export {
  applyRelationSelector,
  buildRelationSelector,
  composeRelationSelectors,
  describeMarker,
  markerAnchor,
  markerAnchorClass,
  MARKER_RELATIONS,
  RELATION_SELECTORS,
} from "./marker-registry.ts";
export type { MarkerDescriptor, MarkerRelation, RelationSelectors } from "./marker-registry.ts";

// Re-export the generic TS utilities from the private `@bearbones/utils`
// workspace package so the codegen-patch's emitted host import
// (`from '@bearbones/vite'`) keeps working without the host needing to
// install `@bearbones/utils` (which never publishes). The runtime + types
// are inlined into this dist via `deps.alwaysBundle` in `vite.config.ts`,
// and `@bearbones/utils#build` runs before this package's build (see
// `run.tasks.build.dependsOn`).
export { substituteAmp } from "@bearbones/utils";
export type { SubstituteAmp } from "@bearbones/utils";

// NOTE: `BearbonesUtilityName` is no longer re-exported as a static type.
// The set of valid utility names is now derived from the host project's
// resolved Panda tokens at runtime; the only authoritative type union is
// the one emitted into the patched `css.d.ts` by `codegen-patch.ts`.
// Consumers wanting a typed utility-name union should import it from there:
//
//   import type { BearbonesUtilityName } from '../styled-system/css';
