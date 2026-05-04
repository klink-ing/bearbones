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
    // `@klinking/panda-utils` is a private workspace package that never
    // publishes. Inline its source (and types) into this dist so consumers
    // don't see an unresolvable workspace specifier in the published deps.
    deps: { alwaysBundle: ["@klinking/panda-utils"] },
    // Skip the pre-build wipe of `dist/` ONLY in watch mode. The default
    // `clean: true` wipes the output dir before each build — including the
    // very first build of a `vp pack --watch` session — leaving a window
    // where the bundle entry temporarily doesn't exist. The root `dev`
    // task `dependsOn`-pre-builds this package via `vp pack` and then runs
    // `vp pack --watch` in parallel with the website; with `clean: false`
    // the watcher's incremental builds atomically overwrite the existing
    // bundle in place rather than racing the website's Vite/Panda config
    // loader through a missing entry.
    clean: !process.argv.includes("--watch"),
    plugins: [
      inlineTemplatesPlugin({
        templatesDir: TEMPLATES_DIR,
        outputPath: OUTPUT_PATH,
      }),
    ],
  },
  lint: {
    // The `.ts` files under `src/templates/` are *data* — read at build /
    // test setup time and inlined into `src/templates.generated.ts`. They
    // import types from paths that only resolve in Panda's emitted layout
    // and are intentionally never imported as code in this package.
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
