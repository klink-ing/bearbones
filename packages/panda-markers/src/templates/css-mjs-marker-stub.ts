/* eslint-disable */
// @ts-nocheck

// Template — read at runtime by `codegen-templates.ts` and appended to
// Panda's emitted `styled-system/css/css.mjs`. The contents are runtime
// JavaScript (an ESM module body) for the host project; this file is a
// `.ts` file only so it shares the templates/ directory and tooling
// pipeline with the type-level templates. No placeholders.
//
// The leading sentinel comment is also used by `patchCssRuntime` for
// idempotency — re-running the patch over an already-patched artifact
// detects this string and short-circuits.
//
// Everything above the fence below is template-author metadata and is
// stripped from the emitted output by `codegen-patch-render.ts`.
// ---bearbones-template-emit-below---
/* @klinking/panda-markers: marker stub */
export function marker(_id) {
  throw new Error(
    "@klinking/panda-markers: marker() was called at runtime. " +
      "This usually means the markers transform did not run before this module. " +
      "Verify Panda's plugins include markersPlugin() (or hooks include markersHooks()) " +
      "and that the file imports `marker` from 'styled-system/css'.",
  );
}
