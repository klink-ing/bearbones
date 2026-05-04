/**
 * Render the text blocks the markers plugin's `codegen:prepare` splices
 * into Panda's emitted artifacts:
 *
 *   - `renderMarkerBlock(conditions)` — `BearbonesMarker<Id>` interfaces +
 *     condition-derived `_<name>` shortcuts + the `marker()` declaration.
 *     Spliced after the `Styles` type alias in `css.d.ts`.
 *
 *   - `renderMarkerStub()` — runtime guard appended to `css.mjs` that
 *     throws if `marker()` is ever called unrewritten.
 *
 * Templates live in `src/templates/` as real TypeScript so editors
 * highlight them and reviewers can read meaningful diffs. Only the dynamic
 * condition lines are computed here.
 */

import { loadTemplateBody } from "@klinking/panda-utils";
import { loadTemplate } from "./codegen-templates.ts";

const CONDITION_SENTINEL_LINE =
  '  readonly __BEARBONES_CONDITION_PLACEHOLDER__: "__BEARBONES_CONDITION_PLACEHOLDER__";';

/** Sentinel comment dropped into the runtime artifact for idempotency. */
export const RUNTIME_PATCH_SENTINEL = "/* @klinking/panda-markers: marker stub */";

export function renderMarkerBlock(conditions: readonly { name: string; value: string }[]): string {
  const conditionLines =
    conditions.length === 0
      ? ""
      : conditions
          .map(({ name, value }) => `  readonly ${JSON.stringify(name)}: ${JSON.stringify(value)};`)
          .join("\n");
  const body = loadTemplateBody("css-d-ts-marker", loadTemplate);
  if (!body.includes(CONDITION_SENTINEL_LINE)) {
    throw new Error(
      `@klinking/panda-markers codegen-patch: template "css-d-ts-marker" is missing the ` +
        `expected condition sentinel.`,
    );
  }
  return body.replace(CONDITION_SENTINEL_LINE, conditionLines);
}

export function renderMarkerStub(): string {
  return loadTemplateBody("css-mjs-marker-stub", loadTemplate);
}
