/**
 * Loader for the static `.ts` template files under `./templates/`. Templates
 * are TypeScript source for *Panda's emitted artifact*, not for this
 * package — they're treated as data (read via `fs.readFileSync`), never
 * imported as code, and excluded from this package's `tsconfig`.
 *
 * `import.meta.url` resolves to this file's location at runtime: in dev
 * (vitest, where source is loaded directly) it's `src/codegen-templates.ts`,
 * so `./templates/<name>.ts` resolves to `src/templates/<name>.ts`. After
 * `vp pack` bundles this module into `dist/index.mjs` and the post-pack
 * step copies `src/templates/` to `dist/templates/`, `import.meta.url`
 * resolves to `dist/index.mjs` and `./templates/<name>.ts` resolves to
 * `dist/templates/<name>.ts`. Same source path expression works in both
 * environments.
 *
 * Reads are cached in a module-level Map keyed by name so Panda's watch-
 * mode codegen passes don't repeatedly hit the disk.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type TemplateName = "css-d-ts-injected" | "css-d-ts-marker" | "css-mjs-marker-stub";

const cache = new Map<TemplateName, string>();

export function loadTemplate(name: TemplateName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const url = new URL(`./templates/${name}.ts`, import.meta.url);
  const contents = readFileSync(fileURLToPath(url), "utf8");
  cache.set(name, contents);
  return contents;
}
