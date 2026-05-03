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
  run: {
    tasks: {
      // Build needs `@bearbones/utils` to have produced its dist first so we
      // can resolve and inline its types/runtime. The dependsOn ensures
      // `vp run -r build` (and any consumer of `@bearbones/vite#build`) runs
      // utils' build before this one. Mirrors what a plain `package.json`
      // script chain would force, but discoverable in one place.
      build: {
        command: "vp pack",
        cache: true,
        dependsOn: ["@bearbones/utils#build"],
      },
    },
  },
});
