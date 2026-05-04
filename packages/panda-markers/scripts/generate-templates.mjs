#!/usr/bin/env node
/**
 * Inline `src/templates/*.ts` into a single `src/templates.generated.ts`
 * module consumed by `src/codegen-templates.ts`. Thin wrapper over
 * `@klinking/panda-utils/build`'s `generateTemplates()`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateTemplates as runGenerate } from "@klinking/panda-utils/build";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = dirname(SCRIPT_DIR);

const CONFIG = {
  templatesDir: join(PKG_DIR, "src", "templates"),
  outputPath: join(PKG_DIR, "src", "templates.generated.ts"),
};

export function generateTemplates() {
  return runGenerate(CONFIG);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateTemplates();
}

export default function vitestGlobalSetup() {
  generateTemplates();
}
