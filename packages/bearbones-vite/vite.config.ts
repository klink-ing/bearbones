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
    // The `.ts` files under `src/templates/` are *data* — read at build /
    // test setup time by `scripts/generate-templates.mjs` and inlined into
    // `src/templates.generated.ts`. They import types from paths that only
    // resolve in Panda's emitted directory (`../types/index`, …) and are
    // intentionally never imported as code in this package. Excluding them
    // from lint and tsgolint mirrors the `exclude: ["src/templates"]` rule
    // in tsconfig.
    //
    // The generated file is also excluded — it carries the same template
    // bodies (with the same template-internal `// @ts-nocheck` directives)
    // verbatim as string contents, and has nothing meaningful to lint.
    ignorePatterns: ["src/templates/**", "src/templates.generated.ts"],
  },
  test: {
    // Inline the templates before any test module is imported. The setup
    // script has top-level side effects (writes `src/templates.generated.ts`)
    // and exports a no-op default to satisfy vitest's globalSetup contract.
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
      // The leading `node scripts/generate-templates.mjs` regenerates
      // `src/templates.generated.ts` from `src/templates/*.ts` so the
      // template bodies are inlined into the bundle as string constants.
      // No runtime fs reads, no `import.meta.url` reliance — works in any
      // ESM-or-CJS environment Panda's config loader hands us to.
      build: {
        command: "node scripts/generate-templates.mjs && vp pack",
        cache: true,
        dependsOn: ["@bearbones/utils#build"],
      },
    },
  },
});
