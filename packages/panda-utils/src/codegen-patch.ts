/**
 * Contributor-style API for patching Panda's emitted `css.d.ts` and
 * `css.mjs` artifacts. Each plugin builds its own list of `CssDtsPatch` /
 * `CssMjsPatch` entries and the shared applier here composes them into
 * the final source string via magic-string (which handles offset bookkeeping
 * across multiple inserts/replaces).
 *
 * Two plugin layers (markers, shorthand) splice into the same files
 * independently. Each plugin's patches reference anchors located in the
 * input source it received — when both plugins are installed, Panda calls
 * each plugin's `codegen:prepare` hook in turn, and each hook re-locates
 * its anchors in the source it sees (which may already include the prior
 * plugin's splices). Both plugins' anchors are robust under that.
 */

import MagicString from "magic-string";

export interface CssDtsPatch {
  /**
   * Position in the source where the patch applies. `kind: "insert"` puts
   * `text` at this offset (existing content shifts right). `kind: "replace"`
   * replaces `[position, end)` with `text`.
   */
  position: number;
  end?: number;
  kind: "insert" | "replace";
  text: string;
}

export interface CssMjsPatch {
  /**
   * Sentinel substring already present in the source means this patch has
   * already been applied — skip. Each plugin chooses a unique sentinel
   * (typically a leading comment in its appended block).
   */
  idempotencySentinel?: string;
  /** Block to append at the end of the runtime artifact. */
  appendBlock: string;
}

/**
 * Apply a list of `css.d.ts` patches in the order given. Edits compose
 * cleanly across overlapping ranges as long as `replace` ranges don't
 * intersect each other (single-source semantics — each plugin's range
 * is owned by that plugin).
 */
export function applyCssDtsPatches(source: string, patches: readonly CssDtsPatch[]): string {
  if (patches.length === 0) return source;
  const out = new MagicString(source);
  for (const patch of patches) {
    if (patch.kind === "insert") {
      out.appendLeft(patch.position, patch.text);
    } else {
      if (patch.end === undefined) {
        throw new Error(
          `@klinking/panda-utils: replace patch at offset ${patch.position} is missing \`end\`.`,
        );
      }
      out.overwrite(patch.position, patch.end, patch.text);
    }
  }
  return out.toString();
}

/**
 * Apply a list of `css.mjs` patches by appending each block to the end of
 * the source. Idempotent per-patch via `idempotencySentinel` — a re-run of
 * the same patch on already-patched source is a no-op.
 */
export function applyCssMjsPatches(source: string, patches: readonly CssMjsPatch[]): string {
  let out = source;
  for (const patch of patches) {
    if (patch.idempotencySentinel && out.includes(patch.idempotencySentinel)) continue;
    const leading = out.endsWith("\n") ? "\n" : "\n\n";
    const trailing = patch.appendBlock.endsWith("\n") ? "" : "\n";
    out = `${out}${leading}${patch.appendBlock}${trailing}`;
  }
  return out;
}

/**
 * Plugin-side contributor: given the input artifact source, return the
 * patches to apply. Plugins implement this and pass it to
 * `patchPandaArtifacts` to drive Panda's `codegen:prepare` hook.
 *
 * `dtsPatchesFor(source)` is called with the `css.d.ts` source; the
 * plugin returns an array of patches whose offsets are positions in that
 * exact `source`. Same contract for `mjsPatchesFor(source)`.
 */
export interface ArtifactPatchContributor {
  dtsPatchesFor?(source: string): readonly CssDtsPatch[];
  mjsPatchesFor?(source: string): readonly CssMjsPatch[];
}

/**
 * Walk a Panda `Artifact[]` array, find the `css-fn` artifact's `css.d.ts`
 * and `css.mjs` files, and rewrite their `code` by running the contributor
 * through the appliers.
 */
export function patchPandaArtifacts(
  artifacts: PandaArtifact[],
  contributor: ArtifactPatchContributor,
): PandaArtifact[] {
  return artifacts.map((artifact) => {
    if (artifact.id !== "css-fn") return artifact;
    return {
      ...artifact,
      files: artifact.files.map((file) => {
        if (file.code === undefined) return file;
        if (file.file === "css.d.ts" && contributor.dtsPatchesFor) {
          const patches = contributor.dtsPatchesFor(file.code);
          return { ...file, code: applyCssDtsPatches(file.code, patches) };
        }
        if (file.file === "css.mjs" && contributor.mjsPatchesFor) {
          const patches = contributor.mjsPatchesFor(file.code);
          return { ...file, code: applyCssMjsPatches(file.code, patches) };
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
