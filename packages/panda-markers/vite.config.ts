import { defineConfig } from "vite-plus";
import { inlineTemplatesPlugin } from "@klinking/panda-utils/build";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(PKG_DIR, "src", "templates");
const OUTPUT_PATH = join(PKG_DIR, "src", "templates.generated.ts");

export default defineConfig({
  pack: {
    dts: true,
    exports: true,
    deps: { alwaysBundle: ["@klinking/panda-utils"] },
    clean: !process.argv.includes("--watch"),
    plugins: [
      inlineTemplatesPlugin({
        templatesDir: TEMPLATES_DIR,
        outputPath: OUTPUT_PATH,
      }),
    ],
  },
  lint: {
    ignorePatterns: ["src/templates/**", "src/templates.generated.ts"],
  },
  test: {
    globalSetup: ["./scripts/generate-templates.mjs"],
  },
  run: {
    tasks: {
      build: {
        command: "vp pack",
        cache: true,
        dependsOn: ["@klinking/panda-utils#build"],
      },
    },
  },
});
