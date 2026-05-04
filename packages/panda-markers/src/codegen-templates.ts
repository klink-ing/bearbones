/**
 * Loader for the static `.ts` template files under `./templates/`. The
 * template bodies are inlined at build / test setup time into
 * `./templates.generated.ts` by `@klinking/panda-utils/build` (called from
 * `vite.config.ts` and `scripts/generate-templates.mjs`).
 */

import type { TemplateLoader } from "@klinking/panda-utils";
import { TEMPLATES, type TemplateName } from "./templates.generated.ts";

export type { TemplateName };

export const loadTemplate: TemplateLoader = (name) => TEMPLATES[name as TemplateName];
