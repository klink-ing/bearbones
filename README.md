# bearbones

Typed utility-class styling on top of [PandaCSS](https://panda-css.com).

`bearbones` is a small, opinionated styling library that produces fully static
atomic CSS, colocates styles in `.tsx` files, and supports parent-state-driven
child styling without parents needing knowledge of children. Authoring uses a
single `css()` function that accepts both Tailwind-flavored utility strings and
Panda-flavored object styles in the same call.

> **Status: MVP, in active development.** The architecture is proven end-to-end
> (typed utility-string lowering, descendant-selector group conditions, atomic
> CSS extraction with token resolution) but the surface is narrow and the type
> generator is still a skeleton. See [the design spec](#design-spec) for the
> full picture and follow-ups.

## What it looks like

```tsx
import { css } from "../styled-system/css";
import { cx, group } from "bearbones";

const cardGroup = group("card");

function Card({ title }: { title: string }) {
  return (
    <article className={cx(css("p-4", "rounded-md", "bg-white"), cardGroup.anchor)}>
      <h2
        className={css("text-lg", "font-bold", {
          [cardGroup.hover]: "text-blue-500",
        })}
      >
        {title}
      </h2>
    </article>
  );
}
```

When the user hovers `<article>`, the `<h2>`'s color flips — driven entirely by
a generated descendant-selector atomic CSS rule. No JS runtime, no parent
knowledge of children, fully type-checked.

## Repository layout

This is a [Vite+](https://viteplus.dev) pnpm monorepo with five workspaces:

```
apps/
  website/                # End-to-end demo + visual proof
packages/
  bearbones/              # Public facade (cx, group, type re-exports)
  bearbones-preset/       # Panda preset
  bearbones-vite/         # Panda hooks + Vite plugin (the lowering transform)
  bearbones-codegen/      # Type generator (skeleton)
  utils/                  # Reserved for shared utilities; unused for MVP
```

The `bearbones-vite` package is the heart of the project. Its `transform.ts`
implements:

- **Utility-string lowering** — `css('p-4', 'bg-blue-500')` → Panda's native
  `css({ p: '4' }, { bg: 'blue.500' })` form before Panda's extractor sees the
  source.
- **Group symbol resolution** — `group('card')` declarations are rewritten to
  frozen object literals, and `[cardGroup.hover]` references are rewritten to
  the registered Panda condition name (e.g. `_groupHover_card_a3f4b2c1`, where
  the suffix is a module-scoped hash). Works across files via on-demand source
  scanning.
- **Project pre-scan** — discovers every `group()` declaration during
  `config:resolved` so its conditions are registered before any file is parsed.

The transform is exposed in two places: as a Panda `parser:before` hook (for
static CSS extraction) and as a Vite plugin (for the dev-server JS pipeline).
Both share one implementation so behavior is consistent.

## Getting started

This project requires Node 22+ and pnpm 10. Install [Vite+'s `vp`
CLI](https://viteplus.dev/guide/install) globally if you haven't already, then:

```bash
pnpm install
```

The `prepare` script runs `vp config` automatically and wires up commit hooks.

### Common commands

Run from the repo root:

```bash
# Lint, format, typecheck, and run all tests. CI gates on this.
pnpm run check

# Auto-fix formatting (oxfmt). Lint warnings still need manual attention.
pnpm run fix

# Run the demo dev server (http://localhost:5173).
pnpm run dev

# Build everything (packages + the demo website).
vp run -r build
```

### Inside `apps/website`

```bash
pnpm --filter website run dev      # dev server + panda --watch
pnpm --filter website run build    # production CSS + JS bundle
pnpm --filter website run codegen  # just regenerate styled-system types
```

After a production build, the emitted CSS file at
`apps/website/dist/assets/index-*.css` will contain rules like (with `a3f4b2c1`
standing in for the per-group hash):

```css
.bearbones-group-card_a3f4b2c1:is(:hover, [data-hover]) .groupHover_card_a3f4b2c1\:c_blue\.500 {
  color: var(--colors-blue-500);
}
```

That descendant-selector atomic class is the central architectural claim of
the design — token-resolved, deduplicated, and entirely static.

## Design spec

The complete design — context, public API, ~25 code samples, preset & token
strategy, lowering transform, type generation, constraints, verification, and
known follow-ups — is at
[`docs/superpowers/specs/2026-05-01-bearbones-design.md`](docs/superpowers/specs/2026-05-01-bearbones-design.md)
in the local plan store, or you can read the working copy in this repo's
brainstorming output. Key follow-ups tracked there:

- **Type augmentation in codegen.** Today the demo casts Panda's `css()` to
  accept utility strings. `@bearbones/codegen` should patch the generated
  `css()` signature in place so the cast becomes unnecessary.
- **Facade rewriting.** `import { css } from 'bearbones'` should resolve to
  the host project's `styled-system/css`. Today consumers import directly from
  the relative path.
- **Tailwind v4 token grid.** The MVP relies on Panda's preset-base + preset-
  panda token grid. The spec calls for a native Tailwind v4 port shipped in
  `@bearbones/preset`.

## CI

Pull requests run `.github/workflows/ci.yml`, which executes `pnpm run check`
on Ubuntu with Node 22. Merging is gated on this passing.
