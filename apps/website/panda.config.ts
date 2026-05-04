import { defineConfig } from "@pandacss/dev";
import { markersPreset, markersPlugin } from "@klinking/panda-markers";
import { shorthandPlugin } from "@klinking/panda-shorthand";

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
  // `eject` defaults to false; safest path is to extend via
  // theme/conditions and let the defaults flow through.
  conditions: markersPreset().conditions,
  // Hook bundles for both plugins. Panda's hook-sharing API
  // (https://panda-css.com/docs/concepts/hooks#sharing-hooks) composes
  // these into a single hook per name.
  plugins: [markersPlugin(), shorthandPlugin()],
  strictPropertyValues: true,
  strictTokens: true,
});
