/**
 * Render the text blocks that the shorthand plugin's `codegen:prepare`
 * splices into Panda's emitted `css.d.ts`. Substitutes the dynamic
 * utility-name union into a static template body, then returns:
 *
 *   - `injectedBlock` — type aliases for `BearbonesUtilityName` /
 *     `BearbonesNested` / `BearbonesSystemStyleObject`, spliced after Panda's
 *     `SystemStyleObject` import.
 *   - `rewrittenStyles` — the replacement body for the `Styles` alias,
 *     widened to accept `BearbonesSystemStyleObject`.
 *
 * The template body lives in `src/templates/css-d-ts-injected.ts` as real
 * TypeScript so editors highlight it and reviewers can read meaningful
 * diffs. Only the dynamic utility-name union is computed here.
 */

import { loadTemplateBody } from "@klinking/panda-utils";
import { loadTemplate } from "./codegen-templates.ts";

const UTILITY_NAMES_SENTINEL = '"__BEARBONES_UTILITY_NAMES__"';

export function renderInjectedBlock(utilityNames: readonly string[]): string {
  const union =
    utilityNames.length === 0 ? "never" : utilityNames.map((n) => JSON.stringify(n)).join(" | ");
  const body = loadTemplateBody("css-d-ts-injected", loadTemplate);
  if (!body.includes(UTILITY_NAMES_SENTINEL)) {
    throw new Error(
      `@klinking/panda-shorthand codegen-patch: template "css-d-ts-injected" is missing the ` +
        `expected sentinel ${JSON.stringify(UTILITY_NAMES_SENTINEL)}.`,
    );
  }
  return body.replace(UTILITY_NAMES_SENTINEL, union);
}

/** The replacement body for the `Styles` type alias declaration. */
export const REWRITTEN_STYLES =
  "type Styles = BearbonesSystemStyleObject | undefined | null | false";
