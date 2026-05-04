/**
 * Patch contributor for the shorthand plugin. Plugs into the shared
 * `patchPandaArtifacts` helper from `@klinking/panda-utils` so the
 * markers plugin's contributor and this one compose without either
 * needing to know about the other.
 *
 * Two splices land in `css.d.ts`:
 *   - `BearbonesUtilityName` union + nested-object types injected after
 *     Panda's `SystemStyleObject` import.
 *   - The `Styles` type alias is replaced so its body widens to accept
 *     `BearbonesSystemStyleObject`.
 *
 * Nothing is patched into `css.mjs` — utility-string lowering happens at
 * build time, so the runtime artifact is unchanged.
 */

import {
  locateCssDtsAnchors,
  type ArtifactPatchContributor,
  type CssDtsPatch,
} from "@klinking/panda-utils";
import { listUtilities } from "./utility-map.ts";
import { REWRITTEN_STYLES, renderInjectedBlock } from "./codegen-render.ts";

/**
 * Build the `css.d.ts` patches for a given utility-name vocabulary.
 * Exported so tests can drive it with a fixed input.
 */
export function buildCssDtsPatches(source: string, utilityNames: readonly string[]): CssDtsPatch[] {
  const anchors = locateCssDtsAnchors(source);
  const injectedBlock = renderInjectedBlock(utilityNames);
  return [
    {
      kind: "insert",
      position: anchors.importEnd,
      text: `\n${injectedBlock}`,
    },
    {
      kind: "replace",
      position: anchors.stylesRange[0],
      end: anchors.stylesRange[1],
      text: REWRITTEN_STYLES,
    },
  ];
}

/**
 * Live patch contributor — pulls the utility-name vocabulary from the
 * runtime stash (populated in `config:resolved`).
 */
export const shorthandPatchContributor: ArtifactPatchContributor = {
  dtsPatchesFor(source) {
    return buildCssDtsPatches(source, listUtilities());
  },
};
