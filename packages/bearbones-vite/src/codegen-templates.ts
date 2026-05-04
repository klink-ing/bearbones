/**
 * Loader for the static `.ts` template files under `./templates/`.
 *
 * The template bodies are inlined at build / test setup time into
 * `./templates.generated.ts` by `scripts/generate-templates.mjs`. The
 * loader here just looks them up by name. No runtime I/O, no
 * `import.meta.url` — that scheme broke when Panda's config loader
 * bundled this package via esbuild and emitted CJS, which strips
 * `import.meta.url` to an empty string.
 */

import { TEMPLATES, type TemplateName } from "./templates.generated.ts";

export type { TemplateName };

export function loadTemplate(name: TemplateName): string {
  return TEMPLATES[name];
}
