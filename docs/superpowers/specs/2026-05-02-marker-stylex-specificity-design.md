# Marker selectors mirror StyleX `when.*` — design

**Status:** Pre-implementation
**Date:** 2026-05-02
**Issue:** [klink-ing/bearbones#5](https://github.com/klink-ing/bearbones/issues/5)

## Problem

Bearbones' marker chain (`marker(':sel').is.<relation>`) compiles to raw CSS selectors that work — but their specificity is wrong. The current shapes ([packages/bearbones-vite/src/marker-registry.ts:132](packages/bearbones-vite/src/marker-registry.ts:132)) put the marker anchor and the modifier directly into the selector body:

| Relation     | Today's selector                           | Specificity |
| ------------ | ------------------------------------------ | ----------- |
| `ancestor`   | `${anchor}${mod} &`                        | 0,3,0       |
| `descendant` | `&:has(${anchor}${mod})`                   | 0,3,0       |
| `sibling`    | `& ~ ${anchor}${mod}, ${anchor}${mod} ~ &` | 0,3,0       |

A plain utility class is 0,1,0. So a marker rule unconditionally beats a utility — which is the opposite of what users expect when toggling a marker on/off. There's also no clean ordering between relations: every relation lands at the same 0,3,0 level, so cascade ordering between e.g. `ancestor` and `descendant` rules on the same property reduces to source-order luck.

StyleX shipped `stylex.when.*` in v0.16.0 (2025-09-25) and solved exactly this problem: every `when.*` selector wraps the marker side in `:where(...)`, which is specificity-neutral. The marker rule then sits at the same level as a plain utility — and within `:where()` the ranking between relations comes from cascade source order, which StyleX controls. We want the same shape and the same specificity contract for bearbones' markers.

The issue also calls out a maintainability problem: today's selectors are an inline `switch` statement inside `buildRelationSelector`. The user wants the templates collected in one readable table at the top of the module so changing them is a one-stop edit.

## Goals

1. **Match StyleX's selector shapes** byte-for-byte (modulo Panda's `&`-flat-substitution model in place of StyleX's `*`).
2. **Match StyleX's specificity contract**: marker observation contributes zero specificity, only the styled element's own class counts.
3. **Expose the five-relation surface** StyleX uses: `ancestor`, `descendant`, `siblingBefore`, `siblingAfter`, `siblingAny`. Drop the current single `sibling`.
4. **Centralize selector templates** in one readable table, replacing the inline `switch`.

Note: the issue's example named `anySibling` (matching StyleX); we use `siblingAny` for naming consistency with the other two `sibling*` relations. Functionally identical to StyleX's `anySibling`.

## Approach

Replace the selector bodies in `buildRelationSelector` with `:where(...)`-wrapped variants that fit Panda's `&`-substitution model. Define them in a single `RELATION_SELECTORS` table at the top of `marker-registry.ts`. Update the typed `is` builder shape, the inline runtime helper, the synthesized marker-record renderer, the tests, and the one consumer call site.

### Reference: StyleX's `when.*` selectors

From [`facebook/stylex` `packages/@stylexjs/babel-plugin/src/shared/when/when.js`](https://github.com/facebook/stylex/blob/main/packages/@stylexjs/babel-plugin/src/shared/when/when.js), where `M` is the marker class and `pseudo` is the user-supplied selector fragment (e.g. `:hover`, `[data-state="open"]`):

| Relation        | StyleX-emitted selector                        |
| --------------- | ---------------------------------------------- |
| `ancestor`      | `:where(.M${pseudo} *)`                        |
| `descendant`    | `:where(:has(.M${pseudo}))`                    |
| `siblingBefore` | `:where(.M${pseudo} ~ *)`                      |
| `siblingAfter`  | `:where(:has(~ .M${pseudo}))`                  |
| `anySibling`    | `:where(.M${pseudo} ~ *, :has(~ .M${pseudo}))` |

Every selector is wrapped in `:where(...)`, which gives the whole marker observation specificity 0. StyleX writes the styled element's own class outside the `:where()` (the `.x.x` doubled-class prefix StyleX always emits), so the rule's effective specificity is just the styled element's class.

### Bearbones equivalents

Bearbones doesn't use `*` for the styled element — it uses Panda's `&`, which `postcss-nested` substitutes for the styled element's hashed class at CSS emit time. The five new selectors mirror StyleX's intent under that substitution model:

| Relation        | Bearbones selector                                              | Panda type         | Specificity after `&`-substitution |
| --------------- | --------------------------------------------------------------- | ------------------ | ---------------------------------- |
| `ancestor`      | `:where(${anchor}${mod}) &`                                     | parent-nesting     | 0,1,0                              |
| `descendant`    | `&:where(:has(${anchor}${mod}))`                                | self-nesting       | 0,1,0                              |
| `siblingBefore` | `:where(${anchor}${mod}) ~ &`                                   | parent-nesting     | 0,1,0                              |
| `siblingAfter`  | `&:where(:has(~ ${anchor}${mod}))`                              | self-nesting       | 0,1,0                              |
| `siblingAny`    | `:where(${anchor}${mod}) ~ &, &:where(:has(~ ${anchor}${mod}))` | combinator-nesting | 0,1,0                              |

Concretely, for an anchor `.bearbones-marker-card_abc12345` and a modifier `:hover` styled with utility class `.text_blue_500`, bearbones emits:

```css
:where(.bearbones-marker-card_abc12345:hover) .text_blue_500 {
  color: blue;
}
```

That's specificity 0,1,0 — same as a plain `.text_blue_500 { color: blue; }` rule — so toggle-on/toggle-off semantics are governed by source order in the stylesheet, not by an unintended specificity bump.

### Why this works under Panda

Panda's `parseCondition` ([`@pandacss/core@1.10.0`, `dist/index.js:298–319`](node_modules/.pnpm/@pandacss+core@1.10.0/node_modules/@pandacss/core/dist/index.js)) classifies a selector by checking, in order:

1. `condition.startsWith("&")` → `self-nesting`
2. `condition.endsWith(" &")` → `parent-nesting`
3. `condition.includes("&")` → `combinator-nesting`

All five new shapes hit one of these. `&`-substitution itself runs through `postcss-nested` ([`expandNestedCss`, `dist/index.js:3227`](node_modules/.pnpm/@pandacss+core@1.10.0/node_modules/@pandacss/core/dist/index.js)) which correctly substitutes `&` inside both `:where(...)` wrappers and comma-joined selectors. Verified against the `siblingAny` shape: `:where(.M:hover) ~ &, &:where(:has(~ .M:hover))` flat-substitutes both halves independently of the comma split.

### Why not the alternatives

- **Keep the three current relations and just wrap in `:where()`.** Considered and rejected after design review: the user asked for the StyleX surface to fully match. Current `sibling` already maps to StyleX's `anySibling` (and our new `siblingAny`), but `siblingBefore`/`siblingAfter` are useful semantics StyleX surfaces and we'd otherwise lack. Adding all five now is one rename + two additions; deferring just rebuilds the same change later.
- **Wrap the entire selector — including `&` — in `:where()`.** E.g. `:where(${anchor}${mod} &)`. This neutralizes specificity of the _entire_ selector, not just the marker side, dropping the styled rule to 0,0,0. Wrong: utility classes elsewhere would unconditionally win. We need exactly the StyleX shape: `:where(...)` only around the marker observation.
- **Per-relation `:where()` placement chosen by hand.** Considered, but the table form makes this trivial and leaves no room to misplace the wrapper.
- **Backwards-compat alias for `sibling`.** Rejected. Pre-1.0 internal MVP, one consumer call site, no external users. An alias clutters the readable-template-table the issue explicitly asked for.

## Components

### `packages/bearbones-vite/src/marker-registry.ts`

The single source of truth for relation selector shapes. The current inline `switch` ([buildRelationSelector L132–146](packages/bearbones-vite/src/marker-registry.ts:132)) is replaced by an exported lookup table near the top of the module:

```ts
export type MarkerRelation =
  | "ancestor"
  | "descendant"
  | "siblingBefore"
  | "siblingAfter"
  | "siblingAny";

export const MARKER_RELATIONS = [
  "ancestor",
  "descendant",
  "siblingBefore",
  "siblingAfter",
  "siblingAny",
] as const satisfies readonly MarkerRelation[];

/**
 * The five raw-selector shapes a marker chain compiles to. The argument is the
 * fully-formed marker observer (anchor class + user modifier, e.g.
 * `.bearbones-marker-card_abc:hover`). Each template wraps the marker side in
 * `:where(...)` so it contributes zero specificity, mirroring StyleX's
 * `when.*` API. The styled element's own class — substituted into `&` by
 * Panda's nested-CSS pass — is the only specificity contributor.
 *
 * Edit this table when adding a relation or tuning a shape; nothing else in
 * the package hardcodes these strings.
 */
export const RELATION_SELECTORS: Record<MarkerRelation, (observer: string) => string> = {
  ancestor: (o) => `:where(${o}) &`,
  descendant: (o) => `&:where(:has(${o}))`,
  siblingBefore: (o) => `:where(${o}) ~ &`,
  siblingAfter: (o) => `&:where(:has(~ ${o}))`,
  siblingAny: (o) => `:where(${o}) ~ &, &:where(:has(~ ${o}))`,
};
```

`buildRelationSelector` collapses to:

```ts
export function buildRelationSelector(
  anchorClass: string,
  modifier: string,
  relation: MarkerRelation,
): string {
  return RELATION_SELECTORS[relation](`.${anchorClass}${modifier}`);
}
```

The function-valued table is intentional: it keeps each template a single readable line, lets TypeScript verify the exhaustiveness of the relation set at the type level, and means the runtime helper (below) can be derived from the same table without re-stringifying templates.

### `packages/bearbones-vite/src/transform.ts`

Three changes, all derived from the new table:

1. **Inline runtime helper.** The hand-written `RELATIONS_HELPER_SOURCE` ([transform.ts:518–521](packages/bearbones-vite/src/transform.ts:518)) is regenerated programmatically so the runtime path stays byte-identical to `buildRelationSelector`:

   ```ts
   const RELATIONS_HELPER_SOURCE = `const ${RELATIONS_HELPER_NAME} = (m, a) => {
     const x = "." + a + m;
     return { is: { ${MARKER_RELATIONS.map(
       (r) => `${r}: ${JSON.stringify(RELATION_SELECTORS[r]('" + x + "'))}`,
     ).join(", ")} } };
   };`;
   ```

   The exact string-stitching syntax may shift during implementation (e.g., emit a small helper that `JSON.stringify`s a runtime-evaluated expression), but the constraint is firm: the runtime selector strings must be derived from `RELATION_SELECTORS`, not duplicated.

2. **`renderMarkerRecord`.** The hardcoded three-relation loop ([transform.ts:529–535](packages/bearbones-vite/src/transform.ts:529)) iterates `MARKER_RELATIONS` instead, producing the `_<state>: { is: { … } }` block with all five entries.

3. **Chain recognition.** The AST walker that reads `marker(...).is.<relation>` already gates on `isValidRelation` ([transform.ts:254–256](packages/bearbones-vite/src/transform.ts:254)) which delegates to `MARKER_RELATIONS`. Adding two relations + renaming one falls out automatically — no AST-level logic change.

### `packages/bearbones/src/index.ts`

`BearbonesMarkerBuilder<Id>.is` ([packages/bearbones/src/index.ts:90–99](packages/bearbones/src/index.ts:90)) is updated to expose the five relations as template-literal types matching the new selector shapes:

```ts
export interface BearbonesMarkerBuilder<Id extends string> {
  readonly is: {
    readonly ancestor: `:where(.bearbones-marker-${Id}_${string}) &`;
    readonly descendant: `&:where(:has(.bearbones-marker-${Id}_${string}))`;
    readonly siblingBefore: `:where(.bearbones-marker-${Id}_${string}) ~ &`;
    readonly siblingAfter: `&:where(:has(~ .bearbones-marker-${Id}_${string}))`;
    readonly siblingAny: `:where(.bearbones-marker-${Id}_${string}) ~ &, &:where(:has(~ .bearbones-marker-${Id}_${string}))`;
  };
}
```

Each variant matches Panda's `AnySelector` (`${string}&` | `&${string}`) — the comma-joined `siblingAny` string starts with `:where(...)` not `&`, but its tail ends with `))` so it falls into `${string}&` if the ` &` substring is anywhere in it… wait, more carefully: `AnySelector` is `${string}&` | `&${string}`, both of which match any string that _contains_ `&`. The `siblingAny` shape includes ` ~ &` and `&:where(...)` so it satisfies both branches. All five variants are valid `AnySelector` keys; the chain result still drops cleanly into `BearbonesNestedObject`'s `[K in AnySelector]` branch with no patch changes elsewhere.

### `apps/website/src/__type-tests__/css-typing.ts`

One rename: `cardMarker(":focus-within").is.sibling` → `cardMarker(":focus-within").is.siblingAny` ([css-typing.ts:52](apps/website/src/__type-tests__/css-typing.ts:52)). No new test cases are required — the existing typing tests assert the relation chain is accepted as an `AnySelector` key, and that contract is unchanged.

### `apps/website/src/Demo.tsx`

No changes needed. The demo only uses `.is.ancestor` and `.is.descendant` ([Demo.tsx:29, :36, :48, :49, :85, :94](apps/website/src/Demo.tsx)), which keep their names. Useful side-effect: visual verification that the cascade behavior in the running demo doesn't regress when the specificity drops from 0,3,0 to 0,1,0.

## Testing

Three layers, in order of how directly they exercise the production path:

### 1. Unit tests for `marker-registry.ts`

[`packages/bearbones-vite/tests/marker-registry.test.ts`](packages/bearbones-vite/tests/marker-registry.test.ts) is updated:

- Existing `ancestor`, `descendant`, `sibling` tests are rewritten against the new selector shapes. The `sibling` test is renamed to `siblingAny`.
- New `siblingBefore` and `siblingAfter` tests assert the exact emitted strings.
- A "specificity contract" test asserts that every selector returned by `buildRelationSelector` (across all relations and a representative modifier) contains the substring `:where(`. This is a structural proxy for the specificity guarantee — if a future edit forgets to wrap, this test fails.
- The `endsWith(" &")` / `startsWith("&")` Panda-compatibility test is updated to cover all five relations and document which Panda nesting type each maps to.

### 2. Unit tests for `transform.ts`

[`packages/bearbones-vite/tests/transform.test.ts`](packages/bearbones-vite/tests/transform.test.ts) is updated:

- The three regex assertions pinning the old `.is.ancestor`, `.is.descendant`, `.is.sibling` shapes ([transform.test.ts:91, :192, :231 area](packages/bearbones-vite/tests/transform.test.ts:91)) are rewritten against the new strings. The `sibling` test is renamed to `siblingAny`.
- Two new tests cover `.is.siblingBefore` and `.is.siblingAfter` lowering — both call-form and `_<state>.is.<relation>` underscore-form.
- The chain-recognition test for an unknown relation name ([transform.test.ts:278–284](packages/bearbones-vite/tests/transform.test.ts:278) area, the dynamic-arg case) is left as-is; it tests that non-literal modifiers are skipped, not relation gating.

### 3. End-to-end via the existing website

`vp run --filter website codegen && vp check && vp run -r test` exercises the full pipeline. The `__type-tests__/css-typing.ts` rename ensures TypeScript still accepts the chain key. The website demo continues to render and visually demonstrate ancestor/descendant relations (the only ones it uses) — running it post-change confirms that dropping specificity to 0,1,0 doesn't regress the cascade in real use.

## Edge cases & risks

- **`siblingAny` selector is comma-joined.** Panda classifies it as `combinator-nesting` (the comma string contains `&` but neither starts with `&` nor ends with ` &`). `postcss-nested` substitutes `&` independently in each comma-separated half. Verified by reading [`@pandacss/core` `expandNestedCss`](node_modules/.pnpm/@pandacss+core@1.10.0/node_modules/@pandacss/core/dist/index.js) and the postcss-nested behavior; integration test in step 3 above is the empirical check.

- **Browser support for `:where()` and `:has()`.** Both shipped in all evergreen browsers in early 2023. `:has()` is already required by the existing `descendant` relation. `:where()` is more broadly supported than `:has()`; if `:has()` works, `:where()` works.

- **Specificity test is structural, not semantic.** The "every selector contains `:where(`" assertion catches the most likely regression (forgetting the wrapper) but doesn't catch a subtle misplacement (e.g., wrapping `&` instead of the marker observer). A semantic test would require running the selector through a CSS specificity calculator, which is more machinery than the value justifies for an internal MVP. The website demo serves as the empirical specificity check.

- **Selector escaping.** Modifier strings are concatenated raw onto the anchor class (unchanged from current behavior). Garbage in, garbage out. Existing constraint, not a regression.

- **`siblingAny` template-literal type complexity.** The TS type for `siblingAny` interpolates the anchor class twice with `${string}` between. TypeScript handles this fine; the `AnySelector` match works because the string contains `&`. No instantiation depth risk at the scale of bearbones' marker count.

## Out of scope

- **`stylex.defineMarker` / custom marker classes.** StyleX lets users define multiple marker classes per project. Bearbones already does this implicitly — every `marker(id)` call has its own hashed anchor — so this is functionally covered, just under a different surface. No work needed.
- **A `default` relation.** StyleX requires explicit `.when.<relation>` and so does bearbones. Keep it that way.
- **Migration tooling for the `sibling` rename.** One internal call site, renamed by hand. No codemod needed.
- **`stylex.when.media` / `stylex.when.context` analogues.** Out of scope for this change. The relations table is structured so a future `_media` or `_container` relation could be added by adding rows.

## Files touched

- `packages/bearbones-vite/src/marker-registry.ts` — replace `switch` with `RELATION_SELECTORS` table, expand `MARKER_RELATIONS`, update `buildRelationSelector`
- `packages/bearbones-vite/src/transform.ts` — derive runtime helper and `renderMarkerRecord` from the new table
- `packages/bearbones-vite/tests/marker-registry.test.ts` — update three existing tests, add two new, add specificity-contract assertion
- `packages/bearbones-vite/tests/transform.test.ts` — update three existing assertions, add two new lowering tests
- `packages/bearbones/src/index.ts` — update `BearbonesMarkerBuilder.is` template-literal types to the five new shapes
- `apps/website/src/__type-tests__/css-typing.ts` — rename `.is.sibling` → `.is.siblingAny` on line 52
