# bearbones

Two extensions to [PandaCSS](https://panda-css.com): Tailwind-flavored utility
strings inside `css()`, and typed marker symbols for parent-state styling.

Everything else — atomic extraction, conditions, tokens, recipes, the runtime
helpers — comes from Panda unchanged.

> **Status: MVP.** The two extensions work end-to-end with token resolution,
> descendant-selector marker rules, and a passing transform test suite. The
> utility vocabulary is narrow (single-digit families per scale) and the type
> generator is still a skeleton. See [Follow-ups](#follow-ups).

## What's new vs. Panda

### 1. Utility strings inside `css()`

Panda's `css()` only takes object styles. `bearbones` extends it to also accept
Tailwind-flavored utility strings, freely mixed with the object form. Multi-arg
merge semantics are unchanged from Panda.

```ts
css("p-4", "bg-blue-500"); // utility strings only
css({ p: 4, bg: "blue.500" }); // object form (Panda's default)
css("p-4", { _hover: "bg-blue-500" }); // mixed
css("p-4", { p: 8 }); // last wins → p: 8
```

The lowering happens at build time. `css('p-4')` is rewritten to
`css({ p: '4' })` before Panda's extractor or runtime sees it, so the emitted
atomic class is identical to what you'd get authoring the object form by hand —
no runtime overhead, full type safety against typos like `'p-44'`.

### 2. Typed marker symbols

Panda has `_groupHover` for parent-state styling, but the anchor is the
`.group` class — a magic string with no type checking, and only one pool per
DOM tree. Tailwind has named groups (`group/card`) but they're also strings,
prone to typos and accidental collision.

`bearbones` declares markers as typed module-scoped symbols:

```ts
// markers.ts
import { marker } from "bearbones";
export const cardMarker = marker("card");
```

```tsx
// Card.tsx
<article className={cx(css("p-4"), cardMarker.anchor)}>
  <h2 className={css("text-lg", { [cardMarker.hover]: "text-blue-500" })}>{title}</h2>
</article>
```

The parent applies `cardMarker.anchor`. The child styles itself when _its_
`cardMarker` ancestor is hovered. Renaming the symbol via TS rename refactor
propagates to every consumer. Two files declaring `marker('card')` get distinct
hashed condition names so they don't collide.

The emitted CSS uses a descendant-selector atomic class (with `a3f4b2c1`
standing in for the per-marker hash):

```css
.bearbones-marker-card_a3f4b2c1:is(:hover, [data-hover]) .markerHover_card_a3f4b2c1\:c_blue\.500 {
  color: var(--colors-blue-500);
}
```

Multiple markers nest cleanly — `[rowMarker.hover]` and `[cardMarker.hover]` on
the same element produce two distinct atomic rules, each driven by its own
ancestor.

## How it plugs into Panda

Two integration points share one transform implementation, so the same
lowering runs in both the static-extraction path and the dev-server JS path.

```ts
// panda.config.ts
import { defineConfig } from "@pandacss/dev";
import { bearbonesPreset } from "@bearbones/preset";
import { bearbonesHooks } from "@bearbones/vite";

export default defineConfig({
  conditions: bearbonesPreset().conditions,
  hooks: bearbonesHooks(),
  // ...your Panda config
});
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { bearbonesVitePlugin } from "@bearbones/vite";

export default defineConfig({
  plugins: [bearbonesVitePlugin(), react()],
});
```

`bearbonesHooks()` lowers source during Panda's `parser:before` pass so the
emitted `styles.css` contains the right atomic rules. `bearbonesVitePlugin()`
runs the same lowering on TSX modules headed for the browser so runtime calls
to `css('p-4', ...)` resolve correctly. Both paths are required for the
extensions to work end-to-end.

## Repository layout

```
apps/website/             End-to-end demo + visual proof
packages/
  bearbones/              Public facade — cx, marker, type re-exports
  bearbones-preset/       Panda preset
  bearbones-vite/         Lowering transform + css.d.ts patcher (Panda hooks + Vite plugin)
```

## Local development

Node 24+ (the active LTS) and pnpm 10. Install [Vite+'s `vp`
CLI](https://viteplus.dev/guide/install) globally, then:

```bash
pnpm install                       # also runs `vp config` via prepare
pnpm run check                     # CI gates on this
pnpm run fix                       # oxfmt auto-format
pnpm run dev                       # demo at http://localhost:5173
```

## Follow-ups

Tracked in the design spec:

- **Facade rewriting.** `import { css } from 'bearbones'` should resolve to
  the host project's `styled-system/css`. Today consumers import from the
  relative path directly.
- **Wider utility vocabulary.** The MVP ships single-digit families/scales for
  spacing, colors, type, radii, shadows. Adding entries means appending to the
  scale arrays in `packages/bearbones-vite/src/utility-map.ts` — both the
  runtime map and the `BearbonesUtilityName` type derive from those arrays.

Done:

- ~~**Type augmentation.**~~ The demo no longer needs a `TypedCss` cast.
  `@bearbones/vite`'s `codegen:prepare` hook patches Panda's emitted
  `styled-system/css/css.d.ts` directly, widening the `css()` signature to
  accept utility strings + marker condition keys. See
  `packages/bearbones-vite/src/codegen-patch.ts`.
