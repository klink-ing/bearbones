/**
 * Patch contributor for the markers plugin. Plugs into the shared
 * `patchPandaArtifacts` helper from `@klinking/panda-utils` so the
 * shorthand plugin's contributor and this one compose without either
 * needing to know about the other.
 *
 * One splice in `css.d.ts`: `BearbonesMarker<Id>` interfaces + condition-
 * derived `_<name>` shortcuts + the `marker()` declaration are inserted
 * immediately after the `Styles` type alias. We do *not* rewrite the alias
 * — that's the shorthand plugin's job. When both plugins are installed,
 * markers re-locates the alias in the (possibly already-rewritten) source
 * via the AST anchor; the splice lands in the same place either way.
 *
 * One splice in `css.mjs`: the `marker()` runtime stub is appended. The
 * stub throws if it ever runs — the markers transform always rewrites
 * `marker('id')` declarations to a synthesized literal record, so the
 * stub is a misconfiguration alarm.
 */

import {
  locateCssDtsAnchors,
  type ArtifactPatchContributor,
  type CssDtsPatch,
  type CssMjsPatch,
} from "@klinking/panda-utils";
import { listConditionsWithAnchor } from "./conditions-stash.ts";
import { renderMarkerBlock, renderMarkerStub, RUNTIME_PATCH_SENTINEL } from "./codegen-render.ts";

/**
 * Build the `css.d.ts` patches for a given condition vocabulary. Exported
 * so tests can drive it with a fixed input.
 */
export function buildCssDtsPatches(
  source: string,
  conditions: readonly { name: string; value: string }[],
): CssDtsPatch[] {
  const anchors = locateCssDtsAnchors(source);
  const block = renderMarkerBlock(conditions);
  // Insert immediately after the Styles alias's end position. A leading
  // newline keeps the marker block on its own line.
  return [
    {
      kind: "insert",
      position: anchors.stylesRange[1],
      text: `\n\n${block}`,
    },
  ];
}

export function buildCssMjsPatches(): CssMjsPatch[] {
  return [
    {
      idempotencySentinel: RUNTIME_PATCH_SENTINEL,
      appendBlock: renderMarkerStub(),
    },
  ];
}

/**
 * Live patch contributor — pulls the condition vocabulary from the runtime
 * stash (populated in `config:resolved`).
 */
export const markersPatchContributor: ArtifactPatchContributor = {
  dtsPatchesFor(source) {
    return buildCssDtsPatches(source, listConditionsWithAnchor());
  },
  mjsPatchesFor() {
    return buildCssMjsPatches();
  },
};
