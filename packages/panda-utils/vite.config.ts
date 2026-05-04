import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: true,
    exports: true,
    // Two entry points: the `./` runtime helpers consumed by both plugin
    // packages, and the `./build` subpath holding the inline-templates
    // Vite plugin used by each plugin's `vite.config.ts`.
    entry: ["src/index.ts", "src/build.ts"],
  },
});
