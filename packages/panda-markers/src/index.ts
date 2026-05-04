/**
 * Public entry point for `@klinking/panda-markers`.
 *
 * Ships four shapes — pick whichever matches your `panda.config.ts`
 * conventions:
 *
 *   1. `markersPreset()` — a Panda preset (theme conditions, no hooks).
 *      Add to `presets:`. Pairs with `markersPlugin()` for the hook side.
 *
 *   2. `markersPlugin()` — a named Panda plugin built via Panda's
 *      `definePlugin()`, bundling the `config:resolved` + `parser:before`
 *      + `codegen:prepare` hooks. Add to `plugins:` (Panda's hook sharing
 *      API; see https://panda-css.com/docs/concepts/hooks#sharing-hooks).
 *
 *   3. `markersHooks()` — the raw hooks object for users who hand-wire
 *      `hooks: { ...markersHooks() }` instead of using the plugin.
 *
 *   4. `markersVitePlugin()` — the dev-server transform. Required so
 *      runtime `marker()` declarations and relational chains are lowered
 *      before the browser sees them.
 *
 * The marker types template references runtime helpers from this package
 * (`composeRelationSelectors`, `markerAnchor`, `markerAnchorClass`,
 * `substituteAmp`) — those are re-exported below so the host's emitted
 * `css.d.ts` can import them under this package's name.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { definePlugin } from "@pandacss/dev";
import { patchPandaArtifacts, type PandaArtifact } from "@klinking/panda-utils";
import { transform } from "./transform.ts";
import { markersPatchContributor } from "./codegen-patch.ts";
import { hydrateConditions, serializeConditions, setConditions } from "./conditions-stash.ts";

// Inferred from `definePlugin` directly. Importing `PandaPlugin` from
// `@pandacss/types` would drag pkg-types into the dts bundle, where TS6
// trips on pkg-types' `import { CompilerOptions } from 'typescript'`
// (missing `type` modifier — known pkg-types bug).
type PandaPluginValue = ReturnType<typeof definePlugin>;

const CONDITIONS_CACHE_REL_PATH = "node_modules/.cache/klinking-panda-markers/conditions.json";

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
    // the conditions and runtime behavior will degrade.
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

export interface MarkersHooksOptions {
  /** Reserved for future verbose-logging knobs. Currently unused. */
  verbose?: boolean;
}

function buildHooks() {
  return {
    "config:resolved": ({ config }: { config: any }) => {
      // Stash the resolved Panda conditions. The transform's relational
      // marker chains read property-form values (`m._hover`, `m._dark`,
      // ...) from this stash, and the codegen-patch enumerates `_<name>`
      // shortcuts on `BearbonesMarker<Id>` from the same source.
      if (config.conditions && typeof config.conditions === "object") {
        setConditions(config.conditions as Record<string, unknown>);
      }
      const cwd = (config.cwd as string | undefined) ?? process.cwd();
      writeCache(cwd, CONDITIONS_CACHE_REL_PATH, serializeConditions());
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
      return patchPandaArtifacts(artifacts, markersPatchContributor);
    },
  };
}

/**
 * Raw hooks object — for users who hand-wire `hooks: { ...markersHooks() }`
 * directly. Panda's recommended approach is `markersPlugin()`; this is
 * here for symmetry and tests.
 */
export function markersHooks(_options: MarkersHooksOptions = {}) {
  return buildHooks();
}

/**
 * Named Panda plugin (definePlugin). Add to `plugins: [markersPlugin()]`
 * in `panda.config.ts`.
 */
export function markersPlugin(_options: MarkersHooksOptions = {}): PandaPluginValue {
  return definePlugin({
    name: "@klinking/panda-markers",
    hooks: buildHooks() as any,
  });
}

export default markersPlugin;

export interface MarkersVitePluginOptions {
  include?: readonly string[];
  exclude?: readonly string[];
}

/**
 * Vite plugin that runs the markers lowering transform on every TSX/TS
 * module before it's delivered to the browser.
 */
export function markersVitePlugin(_options: MarkersVitePluginOptions = {}): {
  name: string;
  enforce: "pre";
  configResolved: (config: { root: string }) => void;
  transform: (code: string, id: string) => { code: string; map: null } | null;
} {
  let cwd = process.cwd();
  let hydrated = false;
  return {
    name: "klinking-panda-markers",
    enforce: "pre",
    configResolved(config: { root: string }) {
      cwd = config.root;
      readCache(cwd, CONDITIONS_CACHE_REL_PATH, hydrateConditions);
      hydrated = true;
    },
    transform(code: string, id: string) {
      if (!/\.(?:tsx?|jsx?|mts|cts|mtsx?|ctsx?)$/.test(id)) return null;
      if (!hydrated) {
        readCache(cwd, CONDITIONS_CACHE_REL_PATH, hydrateConditions);
        hydrated = true;
      }
      const result = transform({ filePath: id, source: code });
      if (result.content === undefined) return null;
      return { code: result.content, map: null };
    },
  };
}

// Preset — folded in from the deleted `@bearbones/preset` package.
export { markersPreset } from "./preset.ts";
export type { MarkersPresetOptions } from "./preset.ts";

// Re-export internal pieces that tests + advanced wiring consume.
export {
  hydrateConditions,
  serializeConditions,
  setConditions,
  listConditionsWithAnchor,
} from "./conditions-stash.ts";
export { transform } from "./transform.ts";
export {
  buildCssDtsPatches,
  buildCssMjsPatches,
  markersPatchContributor,
} from "./codegen-patch.ts";

// Marker primitives. The codegen-patch's emitted `BearbonesMarkerBuilder`
// types are derived from the return types of these functions so the
// type-level evaluation matches the runtime emit byte-for-byte.
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

// Re-export the `&`-substitution helper from `@klinking/panda-utils` so
// the host's emitted `css.d.ts` can `import { substituteAmp } from
// "@klinking/panda-markers"`. The runtime + types are inlined into this
// dist via `deps.alwaysBundle` in `vite.config.ts`.
export { substituteAmp } from "@klinking/panda-utils";
export type { SubstituteAmp } from "@klinking/panda-utils";
