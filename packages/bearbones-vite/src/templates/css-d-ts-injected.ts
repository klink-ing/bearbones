/* eslint-disable */
// @ts-nocheck

// Template — read at runtime by `codegen-templates.ts` and spliced into
// Panda's emitted `styled-system/css/css.d.ts`. The contents are TypeScript
// for the host project's emitted artifact, NOT for this package; the
// imports below resolve relative to Panda's emitted directory layout
// (`styled-system/css/` → `../types/...`), which is why this file is
// excluded from this package's `tsconfig` and is never imported as code.
//
// Sentinel placeholder substituted at codegen time:
//
//   "__BEARBONES_UTILITY_NAMES__"  →  "p-4" | "bg-blue-500" | ...   (or `never`)
//
// The sentinel is a valid string literal type so this file parses as TS
// and editors highlight it correctly.
//
// Everything above the fence below is template-author metadata and is
// stripped from the emitted output by `codegen-patch-render.ts`.
// ---bearbones-template-emit-below---
import type { Nested, Conditions } from "../types/conditions";
import type { Selectors, AnySelector } from "../types/selectors";
import type { SystemProperties, CssVarProperties } from "../types/style-props";

export type BearbonesUtilityName = "__BEARBONES_UTILITY_NAMES__";

type BearbonesNestedObject<P> = P & {
  [K in Selectors]?: BearbonesNested<P> | readonly BearbonesNested<P>[];
} & {
  [K in AnySelector]?: BearbonesNested<P> | readonly BearbonesNested<P>[];
} & {
  [K in keyof Conditions]?: BearbonesNested<P> | readonly BearbonesNested<P>[];
};

export type BearbonesNested<P> = BearbonesUtilityName | BearbonesNestedObject<P>;

export type BearbonesSystemStyleObject =
  | BearbonesUtilityName
  | Omit<BearbonesNestedObject<SystemProperties & CssVarProperties>, "base">;
