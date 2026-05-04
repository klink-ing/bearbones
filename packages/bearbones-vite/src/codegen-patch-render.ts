/**
 * Render the three text blocks that `codegen-patch.ts` splices into Panda's
 * emitted artifacts. Each renderer:
 *
 *   1. Loads a static `.ts` template from `./templates/` via
 *      `codegen-templates.ts`.
 *   2. Strips the leading template-author metadata (everything up to and
 *      including the `// ---bearbones-template-emit-below---` fence).
 *   3. Substitutes well-defined sentinel placeholders with the dynamic
 *      content for this codegen pass.
 *
 * The static body of each template lives in `src/templates/*.ts` as real
 * TypeScript so editors highlight it and reviewers can read meaningful
 * diffs. Only the dynamic bits — the utility-name union members and the
 * condition-vocabulary map entries — are computed here.
 */

import { loadTemplate, type TemplateName } from "./codegen-templates.ts";

const TEMPLATE_FENCE = "// ---bearbones-template-emit-below---";

/**
 * Sentinel substituted with the rendered utility-name union (or `never`
 * when the host project has no registered utilities). The sentinel is
 * written in the template as a quoted string literal type so the file
 * parses as valid TypeScript on its own.
 */
const UTILITY_NAMES_SENTINEL = '"__BEARBONES_UTILITY_NAMES__"';

/**
 * Sentinel substituted with one rendered `readonly "<name>": "<value>";`
 * line per registered Panda condition. The sentinel is written in the
 * template as a single property declaration so the surrounding type body
 * (`{ ... }`) parses as valid TypeScript on its own. oxfmt strips quotes
 * from valid-identifier keys, so the canonical (post-format) form has a
 * bare key — that's what we match against.
 */
const CONDITION_SENTINEL_LINE =
  '  readonly __BEARBONES_CONDITION_PLACEHOLDER__: "__BEARBONES_CONDITION_PLACEHOLDER__";';

function renderTemplate(name: TemplateName, replacements: ReadonlyArray<[string, string]>): string {
  const source = loadTemplate(name);
  const fenceIdx = source.indexOf(TEMPLATE_FENCE);
  if (fenceIdx < 0) {
    throw new Error(
      `@bearbones/vite codegen-patch: template ${JSON.stringify(name)} is missing the ` +
        `"${TEMPLATE_FENCE}" fence. Add the fence right before the content that should ` +
        `be emitted.`,
    );
  }
  let body = source.slice(fenceIdx + TEMPLATE_FENCE.length);
  if (body.startsWith("\n")) body = body.slice(1);
  for (const [needle, value] of replacements) {
    if (!body.includes(needle)) {
      throw new Error(
        `@bearbones/vite codegen-patch: template ${JSON.stringify(name)} is missing the ` +
          `expected sentinel ${JSON.stringify(needle)}. The renderer and the template ` +
          `have drifted out of sync.`,
      );
    }
    body = body.replace(needle, value);
  }
  return body;
}

/**
 * Render the import block + utility-name union + nested-object types that
 * get spliced in immediately after Panda's own `SystemStyleObject` import.
 * Output shape matches what the previous hand-rolled renderer emitted
 * (modulo whitespace, which oxfmt normalizes for the snapshot test).
 */
export function renderInjectedBlock(utilityNames: readonly string[]): string {
  const union =
    utilityNames.length === 0 ? "never" : utilityNames.map((n) => JSON.stringify(n)).join(" | ");
  return renderTemplate("css-d-ts-injected", [[UTILITY_NAMES_SENTINEL, union]]);
}

/**
 * Render the marker imports + interfaces + condition map + mapped-type
 * shortcuts + `marker()` declaration that get spliced in immediately after
 * the rewritten `Styles` type alias.
 */
export function renderMarkerBlock(conditions: readonly { name: string; value: string }[]): string {
  const conditionLines =
    conditions.length === 0
      ? ""
      : conditions
          .map(({ name, value }) => `  readonly ${JSON.stringify(name)}: ${JSON.stringify(value)};`)
          .join("\n");
  return renderTemplate("css-d-ts-marker", [[CONDITION_SENTINEL_LINE, conditionLines]]);
}

/**
 * Render the runtime `marker()` stub appended to Panda's `css.mjs`. No
 * sentinels — the body is fully static.
 */
export function renderMarkerStub(): string {
  return renderTemplate("css-mjs-marker-stub", []);
}
