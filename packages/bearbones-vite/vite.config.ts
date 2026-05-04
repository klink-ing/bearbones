import { defineConfig } from "vite-plus";
// @ts-expect-error — sibling `.mjs` script with no `.d.ts`. The runtime
// shape of `generateTemplates` is obvious from the implementation: a
// no-arg function returning the list of template file paths it just
// inlined. Adding a declaration file would be more ceremony than value.
import { generateTemplates } from "./scripts/generate-templates.mjs";

/**
 * tsdown plugin that regenerates `src/templates.generated.ts` from
 * `src/templates/*.ts` at the start of every build, and registers each
 * template as a watch dependency. In `vp pack --watch`, editing any
 * template file triggers a rebuild that picks up the change automatically
 * — no separate watcher process, no manual restart.
 *
 * `this.addWatchFile` is provided by the rolldown plugin context. We type
 * `this` inline to avoid an explicit dep on rolldown's Plugin type, which
 * isn't directly resolvable through vite-plus's exports.
 */
function inlineTemplatesPlugin() {
  return {
    name: "bearbones:inline-templates",
    buildStart(this: { addWatchFile(path: string): void }) {
      const files: string[] = generateTemplates();
      for (const file of files) {
        // `addWatchFile` makes rolldown re-trigger `buildStart` (and thus
        // the regen) whenever any of these files change in watch mode.
        this.addWatchFile(file);
      }
    },
  };
}

export default defineConfig({
  pack: {
    dts: true,
    exports: true,
    // `@bearbones/utils` is a private workspace package that never publishes.
    // Inline its source (and types) into this dist so consumers don't see a
    // stale workspace specifier in the published package's dependencies.
    deps: { alwaysBundle: ["@bearbones/utils"] },
    // Skip the pre-build wipe of `dist/` ONLY in watch mode. The default
    // `clean: true` wipes the output dir before each build — including
    // the very first build of a `vp pack --watch` session — leaving a
    // window where the bundle entry temporarily doesn't exist. The root
    // `dev` task `dependsOn`-pre-builds this package via `vp pack` and
    // then runs `vp pack --watch` in parallel with the website; with
    // `clean: false` the watcher's incremental builds atomically
    // overwrite the existing bundle in place rather than racing the
    // website's Vite/Panda config loader through a missing entry.
    //
    // Real one-shot builds keep `clean: true` so removed entries don't
    // leave stale files in `dist/` between runs.
    clean: !process.argv.includes("--watch"),
    plugins: [inlineTemplatesPlugin()],
  },
  lint: {
    // The `.ts` files under `src/templates/` are *data* — read at build /
    // test setup time and inlined into `src/templates.generated.ts`. They
    // import types from paths that only resolve in Panda's emitted directory
    // (`../types/index`, …) and are intentionally never imported as code
    // in this package. Excluding them from lint and tsgolint mirrors the
    // `exclude: ["src/templates"]` rule in tsconfig.
    //
    // The generated file is also excluded — it carries the same template
    // bodies (with the same template-internal `// @ts-nocheck` directives)
    // verbatim as string contents, and has nothing meaningful to lint.
    ignorePatterns: ["src/templates/**", "src/templates.generated.ts"],
  },
  test: {
    // Generate the templates file before any test module is imported. The
    // setup script's default export calls `generateTemplates()` so vitest's
    // globalSetup contract is satisfied without top-level side effects on
    // import.
    globalSetup: ["./scripts/generate-templates.mjs"],
  },
  run: {
    tasks: {
      // Build needs `@bearbones/utils` to have produced its dist first so we
      // can resolve and inline its types/runtime. The dependsOn ensures
      // `vp run -r build` (and any consumer of `@bearbones/vite#build`) runs
      // utils' build before this one. Mirrors what a plain `package.json`
      // script chain would force, but discoverable in one place.
      //
      // Template generation happens inside the `inlineTemplatesPlugin`
      // tsdown plugin above, so `vp pack` is enough — no pre-step.
      build: {
        command: "vp pack",
        cache: true,
        dependsOn: ["@bearbones/utils#build"],
      },
    },
  },
});
