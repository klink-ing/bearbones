/**
 * Patch Panda's emitted `styled-system/css/` artifacts so the project-local
 * `css()` import is the single source of truth for bearbones primitives:
 *
 *   - `css.d.ts` — widens the `css()` signature to accept bearbones utility
 *     strings, and injects the project-local `marker()` declaration plus its
 *     `BearbonesMarker<Id>` / `BearbonesMarkerBuilder<Id>` interfaces. The
 *     `_<name>` shortcut per registered Panda condition is enumerated from
 *     the conditions stash so users get autocomplete for their full
 *     vocabulary, including any extensions.
 *
 *   - `css.mjs` — injects a runtime stub for `marker()` that throws with a
 *     diagnostic message if it ever runs unrewritten. Panda already ships
 *     `cx` in the same artifact (re-exported from `styled-system/css/cx`),
 *     so users get all four primitives — `css`, `cva`/`sva` (via recipes),
 *     `cx`, `marker` — from one import path.
 *
 * Wired into Panda's `codegen:prepare` hook in `index.ts`. Runs once per
 * codegen pass, after `config:resolved` (so the conditions stash is
 * populated) and immediately before Panda writes any artifact to disk.
 *
 * Strategy: the static body of every patched block lives in a real `.ts`
 * template under `src/templates/` (rendered via `codegen-patch-render.ts`),
 * and the two splice points in Panda's `css.d.ts` are located by AST shape
 * (see `codegen-patch-ast.ts`) rather than exact string match — so benign
 * format drift in Panda's emit (whitespace, quote style, comments) doesn't
 * break the patch.
 */

import MagicString from "magic-string";
import { listConditionsWithAnchor } from "./conditions-stash.ts";
import { listUtilities } from "./utility-map.ts";
import { locateSpliceTargets } from "./codegen-patch-ast.ts";
import {
  renderInjectedBlock,
  renderMarkerBlock,
  renderMarkerStub,
} from "./codegen-patch-render.ts";

/**
 * Sentinel comment we drop into the runtime artifact so a re-patch (e.g. on
 * Panda's watch-mode codegen) doesn't append a second copy of the marker
 * stub. Must match the leading line of the runtime template body.
 */
const RUNTIME_PATCH_SENTINEL = "/* @bearbones/vite: marker stub */";

/**
 * Patch the source of `styled-system/css/css.d.ts`. Returns the patched
 * source string. Pure function — no I/O, no side effects (template files
 * are read on first access and cached).
 *
 * Throws if Panda's emitted source doesn't contain the expected splice
 * points (see `codegen-patch-ast.ts` for the matcher).
 */
export function patchCssArtifact(
  source: string,
  utilityNames: readonly string[],
  conditions: readonly { name: string; value: string }[],
): string {
  const targets = locateSpliceTargets(source);

  const injectedBlock = renderInjectedBlock(utilityNames);
  const markerBlock = renderMarkerBlock(conditions);
  const rewrittenStyles = "type Styles = BearbonesSystemStyleObject | undefined | null | false";

  const out = new MagicString(source);
  // Splice the injected types in immediately after Panda's SystemStyleObject
  // import. A leading newline keeps the inserted block on its own line.
  out.appendLeft(targets.importEnd, `\n${injectedBlock}`);
  // Replace the entire `Styles` type alias with our rewritten alias plus the
  // marker block on the following lines.
  out.overwrite(
    targets.stylesRange[0],
    targets.stylesRange[1],
    `${rewrittenStyles}\n\n${markerBlock}`,
  );
  return out.toString();
}

/**
 * Patch `styled-system/css/css.mjs` to add the `marker()` runtime stub. The
 * stub throws if it ever executes — when the bearbones transform has run on
 * a file, every `marker('id')` call site has been rewritten to a synthesized
 * literal record, so the runtime stub only fires as a misconfiguration alarm.
 *
 * Idempotent: if the stub is already present (sentinel comment match), we
 * return the input unchanged. Panda's watch-mode regenerates `css.mjs`
 * fresh on each pass so this idempotency is belt-and-suspenders only.
 */
export function patchCssRuntime(source: string): string {
  if (source.includes(RUNTIME_PATCH_SENTINEL)) return source;
  const stub = renderMarkerStub();
  // Match the previous output shape: one blank line between the existing
  // module body and the appended stub, and a trailing newline.
  const leading = source.endsWith("\n") ? "\n" : "\n\n";
  const trailing = stub.endsWith("\n") ? "" : "\n";
  return `${source}${leading}${stub}${trailing}`;
}

/**
 * Convenience wrapper that patches against the live utility list and
 * conditions stash. Used by the `codegen:prepare` hook in production; tests
 * pass fixed inputs to keep snapshots stable.
 */
export function patchCssArtifactLive(source: string): string {
  return patchCssArtifact(source, listUtilities(), listConditionsWithAnchor());
}

/**
 * Patch a Panda `Artifact[]` array in-place by finding the `css-fn` artifact's
 * `css.d.ts` and `css.mjs` files and rewriting their `code`. Used by the
 * `codegen:prepare` hook.
 */
export function patchArtifacts(artifacts: PandaArtifact[]): PandaArtifact[] {
  return artifacts.map((artifact) => {
    if (artifact.id !== "css-fn") return artifact;
    return {
      ...artifact,
      files: artifact.files.map((file) => {
        if (file.code === undefined) return file;
        if (file.file === "css.d.ts") {
          return { ...file, code: patchCssArtifactLive(file.code) };
        }
        if (file.file === "css.mjs") {
          return { ...file, code: patchCssRuntime(file.code) };
        }
        return file;
      }),
    };
  });
}

export type PandaArtifactId =
  | "helpers"
  | "keyframes"
  | "design-tokens"
  | "types"
  | "css-fn"
  | "cva"
  | "sva"
  | "cx"
  | "create-recipe"
  | "recipes"
  | "recipes-index"
  | "patterns"
  | "patterns-index"
  | "jsx-is-valid-prop"
  | "jsx-helpers"
  | "jsx-factory"
  | "jsx-patterns"
  | "jsx-create-style-context"
  | "jsx-patterns-index"
  | "css-index"
  | "themes"
  | "package.json"
  | "types-jsx"
  | "types-entry"
  | "types-styles"
  | "types-conditions"
  | "types-gen"
  | "types-gen-system"
  | "static-css"
  | "styles.css"
  | "styles"
  | `recipes.${string}`
  | `patterns.${string}`;

export interface PandaArtifactFile {
  file: string;
  code: string | undefined;
}

export interface PandaArtifact {
  id: PandaArtifactId;
  dir?: string[];
  files: PandaArtifactFile[];
}
