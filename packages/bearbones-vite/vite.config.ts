import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: true,
    exports: true,
    // `@bearbones/utils` is a private workspace package that never publishes.
    // Inline its source (and types) into this dist so consumers don't see a
    // stale workspace specifier in the published package's dependencies.
    deps: { alwaysBundle: ["@bearbones/utils"] },
  },
  lint: {
    // The `.ts` files under `src/templates/` are *data* — read at runtime by
    // `codegen-templates.ts` and spliced into Panda's emitted artifacts. They
    // import types from paths that only resolve in Panda's emitted directory
    // (`../types/index`, `../types/conditions`, …) and are intentionally
    // never imported as code in this package. Excluding them from lint and
    // tsgolint mirrors the `exclude: ["src/templates"]` rule in tsconfig.
    ignorePatterns: ["src/templates/**"],
  },
  run: {
    tasks: {
      // Build needs `@bearbones/utils` to have produced its dist first so we
      // can resolve and inline its types/runtime. The dependsOn ensures
      // `vp run -r build` (and any consumer of `@bearbones/vite#build`) runs
      // utils' build before this one. Mirrors what a plain `package.json`
      // script chain would force, but discoverable in one place.
      //
      // After packing, copy `src/templates/` to `dist/templates/`. The
      // codegen-patch loads these `.ts` template files at runtime via
      // `fs.readFileSync(new URL('./templates/...', import.meta.url))`, and
      // `import.meta.url` resolves to `dist/index.mjs` in the published
      // package — so the templates need to exist next to the bundled entry.
      build: {
        command:
          "vp pack && node -e \"require('node:fs').cpSync('src/templates','dist/templates',{recursive:true})\"",
        cache: true,
        dependsOn: ["@bearbones/utils#build"],
      },
    },
  },
});
