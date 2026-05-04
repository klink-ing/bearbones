import { defineConfig } from "vite-plus";
// @ts-expect-error — sibling `.mjs` script with no `.d.ts`. Runtime shape
// is obvious from the implementation; adding declarations is more
// ceremony than value.
import { generateTemplates, listTemplateFiles } from "./scripts/generate-templates.mjs";

/**
 * tsdown plugin that inlines `src/templates/*.ts` into
 * `src/templates.generated.ts` so the bundle has no runtime fs reads or
 * `import.meta.url` reliance.
 *
 * Critical: regen runs ONLY when something actually demands it — on the
 * first build, and on `watchChange` for template source files. If we
 * regenerated on every `buildStart`, we'd write `templates.generated.ts`
 * (which `codegen-templates.ts` imports), and rolldown's import-graph
 * watcher would see that write as a change → fire another `buildStart` →
 * regen again → infinite loop. Gating regen with a `pendingGen` flag
 * breaks that cycle at the root: `buildStart` doesn't write the file
 * unless a real template change has been observed.
 */
function inlineTemplatesPlugin() {
  // Snapshot the template file list at plugin construction. Adding or
  // removing template files later is a config-shape change — restart
  // dev to pick it up.
  const templateFiles: string[] = listTemplateFiles();
  let pendingGen = true;

  return {
    name: "bearbones:inline-templates",
    buildStart(this: { addWatchFile(path: string): void }) {
      if (pendingGen) {
        generateTemplates();
        pendingGen = false;
      }
      // `addWatchFile` registers each template as a watch dep so
      // rolldown will fire `watchChange` for them. Idempotent re-add
      // across builds is fine — rolldown dedups internally.
      for (const file of templateFiles) {
        this.addWatchFile(file);
      }
    },
    watchChange(id: string) {
      // Mark for regen on the next build only when an actual template
      // source file changed. Edits to `templates.generated.ts` (which
      // we just wrote) are ignored here, breaking the self-trigger
      // loop.
      if (templateFiles.includes(id)) {
        pendingGen = true;
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
