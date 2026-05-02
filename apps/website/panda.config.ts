import { defineConfig } from "@pandacss/dev";
import { bearbonesPreset } from "@bearbones/preset";
import { bearbonesHooks } from "@bearbones/vite";

export default defineConfig({
  preflight: true,
  include: ["./src/**/*.{ts,tsx}"],
  // Type-only tests author dummy `css()` calls solely to exercise the
  // augmented `css()` typing surface — they're never executed and shouldn't
  // contribute classes to the production stylesheet. Skip them at extraction.
  exclude: ["./src/__type-tests__/**/*"],
  outdir: "styled-system",
  jsxFramework: "react",
  // We don't list presets explicitly because Panda's defaults
  // (preset-base + preset-panda) provide the token grid and utility
  // shorthands. Specifying `presets` overrides the defaults even though
  // `eject` defaults to false; safest path is to extend via theme/conditions
  // and let the defaults flow through.
  // bearbones-specific conditions are merged into the resolved config by
  // bearbonesHooks() in `config:resolved`.
  conditions: bearbonesPreset().conditions,
  hooks: bearbonesHooks(),
  strictPropertyValues: true,
  strictTokens: true,
});
