# Marker selectors mirror StyleX `when.*` — design

**Status:** Pre-implementation
**Date:** 2026-05-02 (rebased onto main 2026-05-02 after #7 landed)
**Issue:** [klink-ing/bearbones#5](https://github.com/klink-ing/bearbones/issues/5)

## Problem

Bearbones' marker chain (`marker('&:cond').is.<relation>`, `marker._<cond>.is.<relation>`) compiles to raw CSS selectors that work — but their specificity is wrong. The current shapes ([packages/bearbones-vite/src/marker-registry.ts:79](packages/bearbones-vite/src/marker-registry.ts:79)) substitute every `&` in the condition value with the marker's anchor selector, then wrap in the relation:

| Relation     | Today's selector (after `&`-substitution; `M = .anchor + cond`) | Specificity (typical) |
| ------------ | --------------------------------------------------------------- | --------------------- |
| `ancestor`   | `M &`                                                           | 0,3,0 (`:hover`)      |
| `descendant` | `&:has(M)`                                                      | 0,3,0                 |
| `sibling`    | `& ~ M, M ~ &`                                                  | 0,3,0                 |

A plain utility class is 0,1,0. So a marker rule unconditionally beats a utility — the opposite of what users expect when toggling a marker on/off. There's also no clean ordering between relations: every relation lands at roughly the same level, so cascade ordering between e.g. an `ancestor` and a `descendant` rule on the same property reduces to source-order luck.

StyleX shipped `stylex.when.*` in v0.16.0 (2025-09-25) and solved exactly this problem: every `when.*` selector wraps the marker side in `:where(...)`, which is specificity-neutral. The marker rule then sits at the same level as a plain utility — and within `:where()` the ranking between relations comes from cascade source order. We want the same shape and the same specificity contract for bearbones' markers.

The issue also calls out a maintainability problem: today's selectors are an inline `switch` in `buildRelationSelector` ([marker-registry.ts:90–97](packages/bearbones-vite/src/marker-registry.ts:90)). The user wants the templates collected in one readable table so changing them is a one-stop edit.

## Goals

1. **Match StyleX's selector shapes** byte-for-byte (modulo Panda's `&`-placeholder model in place of StyleX's `*` for the styled element).
2. **Match StyleX's specificity contract**: marker observation contributes zero specificity, only the styled element's own class counts.
3. **Expose the five-relation surface** StyleX uses: `ancestor`, `descendant`, `siblingBefore`, `siblingAfter`, `siblingAny`. Drop the current single `sibling`.
4. **Centralize selector templates** in one readable table, replacing the inline `switch`.

Note: the issue's example named `anySibling` (matching StyleX); we use `siblingAny` for naming consistency with the other two `sibling*` relations. Functionally identical to StyleX's `anySibling`.

## Approach

Replace the selector bodies in `buildRelationSelector` with `:where(...)`-wrapped variants. Define them in a single `RELATION_SELECTORS` table at the top of `marker-registry.ts`. Update the inline runtime helper, the synthesized marker-record renderer, the type emit in `codegen-patch.ts`, the tests, and the one consumer call site.

### Reference: StyleX's `when.*` selectors

From [`facebook/stylex` `packages/@stylexjs/babel-plugin/src/shared/when/when.js`](https://github.com/facebook/stylex/blob/main/packages/@stylexjs/babel-plugin/src/shared/when/when.js), where `M` is the marker class and `pseudo` is the user-supplied selector fragment:

| Relation        | StyleX-emitted selector                        |
| --------------- | ---------------------------------------------- |
| `ancestor`      | `:where(.M${pseudo} *)`                        |
| `descendant`    | `:where(:has(.M${pseudo}))`                    |
| `siblingBefore` | `:where(.M${pseudo} ~ *)`                      |
| `siblingAfter`  | `:where(:has(~ .M${pseudo}))`                  |
| `anySibling`    | `:where(.M${pseudo} ~ *, :has(~ .M${pseudo}))` |

Every selector is wrapped in `:where(...)`, which gives the marker observation specificity 0. The styled element's class lives outside the wrap; the rule's effective specificity is just that class.

### Bearbones equivalents

Bearbones doesn't use `*` for the styled element — it uses Panda's `&`, which `postcss-nested` substitutes for the styled element's hashed class at CSS emit time. The condition value (e.g. `&:hover`, `[data-state=open] &`) is `&`-substituted _inside_ `buildRelationSelector` with the marker's anchor class to produce `M`. The five new templates wrap `M` in `:where(...)`:

| Relation        | Bearbones template (`m = condValue.replaceAll("&", "." + anchorClass)`) | Panda type         | Specificity after `&`-substitution |
| --------------- | ----------------------------------------------------------------------- | ------------------ | ---------------------------------- |
| `ancestor`      | `:where(${m}) &`                                                        | parent-nesting     | 0,1,0                              |
| `descendant`    | `&:where(:has(${m}))`                                                   | self-nesting       | 0,1,0                              |
| `siblingBefore` | `:where(${m}) ~ &`                                                      | parent-nesting     | 0,1,0                              |
| `siblingAfter`  | `&:where(:has(~ ${m}))`                                                 | self-nesting       | 0,1,0                              |
| `siblingAny`    | `:where(${m}) ~ &, &:where(:has(~ ${m}))`                               | combinator-nesting | 0,1,0                              |

Concretely, for an anchor `.bearbones-marker-card_abc12345`, condition value `&:hover` (so `m = .bearbones-marker-card_abc12345:hover`), and styled utility class `.text_blue_500`, bearbones emits:

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

All five new shapes hit one of these. `&`-substitution itself runs through `postcss-nested` ([`expandNestedCss`, `dist/index.js:3227`](node_modules/.pnpm/@pandacss+core@1.10.0/node_modules/@pandacss/core/dist/index.js)) which correctly substitutes `&` inside both `:where(...)` wrappers and comma-joined selectors. The `siblingAny` shape `:where(.M:hover) ~ &, &:where(:has(~ .M:hover))` flat-substitutes both halves independently of the comma split.

### Why not the alternatives

- **Keep the three current relations and just wrap in `:where()`.** Considered and rejected after design review: the user asked for the StyleX surface to fully match. Current `sibling` already maps to StyleX's `anySibling` (and our new `siblingAny`), but `siblingBefore`/`siblingAfter` are useful semantics StyleX surfaces and we'd otherwise lack. Adding all five now is one rename + two additions; deferring just rebuilds the same change later.
- **Wrap the entire selector — including `&` — in `:where()`.** E.g. `:where(${m} &)`. This neutralizes specificity of the _entire_ selector, not just the marker side, dropping the styled rule to 0,0,0. Wrong: utility classes elsewhere would unconditionally win. We need exactly the StyleX shape: `:where(...)` only around the marker observation.
- **Backwards-compat alias for `sibling`.** Rejected. Pre-1.0 internal MVP, one consumer call site, no external users. An alias clutters the readable-template-table the issue explicitly asked for.

## Components

### `packages/bearbones-vite/src/marker-registry.ts`

The single source of truth for relation selector shapes. The current inline `switch` ([buildRelationSelector L79–98](packages/bearbones-vite/src/marker-registry.ts:79)) is replaced by an exported lookup table near the top of the module:

```ts
export const MARKER_RELATIONS = [
  "ancestor",
  "descendant",
  "siblingBefore",
  "siblingAfter",
  "siblingAny",
] as const;

export type MarkerRelation = (typeof MARKER_RELATIONS)[number];

/**
 * The five raw-selector shapes a marker chain compiles to. The argument is
 * the marker observer — the user's condition value with every `&` already
 * substituted for the marker's anchor class. Each template wraps that
 * observer in `:where(...)` so it contributes zero specificity, mirroring
 * StyleX's `when.*` API. The trailing `&` (or `&:where(...)` self-nesting
 * form) is Panda's placeholder for the styled element — the only specificity
 * contributor in the final rule.
 *
 * Edit this table when adding a relation or tuning a shape; nothing else in
 * the package hardcodes these strings.
 */
export const RELATION_SELECTORS: Record<MarkerRelation, (m: string) => string> = {
  ancestor: (m) => `:where(${m}) &`,
  descendant: (m) => `&:where(:has(${m}))`,
  siblingBefore: (m) => `:where(${m}) ~ &`,
  siblingAfter: (m) => `&:where(:has(~ ${m}))`,
  siblingAny: (m) => `:where(${m}) ~ &, &:where(:has(~ ${m}))`,
};
```

`buildRelationSelector` collapses to:

```ts
export function buildRelationSelector(
  anchorClass: string,
  condValue: string,
  relation: MarkerRelation,
): string {
  if (!condValue.includes("&")) {
    throw new Error(
      `bearbones: marker() requires the '&' placeholder; got: ${JSON.stringify(condValue)}`,
    );
  }
  const m = condValue.replaceAll("&", `.${anchorClass}`);
  return RELATION_SELECTORS[relation](m);
}
```

The `&`-presence check stays unchanged — it's the existing contract for relational chains. The function-valued table is intentional: it keeps each template a single readable line and lets TypeScript verify the relation-set exhaustiveness at the type level.

### `packages/bearbones-vite/src/transform.ts`

Two changes, both derived from the new table:

1. **Inline runtime helper.** The hand-written `RELATIONS_HELPER_SOURCE` ([transform.ts:476–479](packages/bearbones-vite/src/transform.ts:476)) is regenerated from `RELATION_SELECTORS` so the runtime path stays byte-identical to `buildRelationSelector`. The constraint is firm: the runtime selector strings must be derived from the table, not duplicated. The exact stitching mechanism is an implementation choice. One option (illustrative pseudocode — not a literal snippet to copy):

   ```text
   For each relation r in MARKER_RELATIONS:
     - Compute the template body by calling RELATION_SELECTORS[r](placeholder)
       where `placeholder` is a unique sentinel string.
     - Stringify the result, then split on the sentinel to extract the
       literal-text fragments around it.
     - Emit a runtime-evaluated string-concatenation expression that joins
       those fragments with the live `m` variable (the `&`-substituted
       observer).

   Result: a runtime helper whose `is.<relation>` values are computed by
   the same templates the build-time path uses, with no second copy.
   ```

   Implementer is free to choose any approach (e.g., a placeholder-substitution helper, or a small runtime-side function exported from `marker-registry.ts` that the helper imports) as long as the constraint above holds.

2. **`renderMarkerRecord`.** The hardcoded three-relation loop ([transform.ts:488–495](packages/bearbones-vite/src/transform.ts:488)) iterates `MARKER_RELATIONS` instead, producing the `_<name>: { is: { … } }` block with all five entries per registered condition.

3. **Chain recognition.** The AST walker that reads `marker(...).is.<relation>` already gates on `isValidRelation` ([transform.ts:235–237](packages/bearbones-vite/src/transform.ts:235)) which delegates to `MARKER_RELATIONS`. Adding two relations + renaming one falls out automatically — no AST-level logic change.

### `packages/bearbones-vite/src/codegen-patch.ts`

`renderMarkerTypes` ([codegen-patch.ts:186–213](packages/bearbones-vite/src/codegen-patch.ts:186)) emits the typed `BearbonesMarkerBuilder<Id, Cond>.is` shape. The current three entries use _phantom-literal_ templates parameterized over `Id` and `Cond` (each unique, so TS doesn't collapse to a string-index signature when the chain is used as a computed key alongside CSS properties — see the existing comment block at [codegen-patch.ts:170–185](packages/bearbones-vite/src/codegen-patch.ts:170)):

```ts
readonly is: {
  readonly ancestor: `_bbm_${Id}_${Cond}_a &`;
  readonly descendant: `&_bbm_${Id}_${Cond}_d`;
  readonly sibling: `&_bbm_${Id}_${Cond}_s`;
};
```

These phantom literals don't reflect the actual emitted CSS — the lowering transform substitutes the real composed selector at parser:before time. The phantom keys exist solely to satisfy `AnySelector` (`${string}&` | `&${string}`, both of which match any string containing `&`) without widening to `${string}&`, which would trigger the index-signature collapse the existing comment describes.

Updated emit:

```ts
readonly is: {
  readonly ancestor: `_bbm_${Id}_${Cond}_a &`;
  readonly descendant: `&_bbm_${Id}_${Cond}_d`;
  readonly siblingBefore: `_bbm_${Id}_${Cond}_sb &`;
  readonly siblingAfter: `&_bbm_${Id}_${Cond}_sa`;
  readonly siblingAny: `&_bbm_${Id}_${Cond}_san`;
};
```

Each phantom suffix is unique per relation so two distinct relations on the same `(Id, Cond)` pair don't share a key. Each variant ends with ` &` or starts with `&`, satisfying both branches of `AnySelector`.

### `apps/website/src/__type-tests__/css-typing.ts`

One rename: `cardMarker("&:focus-within").is.sibling` → `cardMarker("&:focus-within").is.siblingAny` ([css-typing.ts:55](apps/website/src/__type-tests__/css-typing.ts:55)). No new test cases are required — the existing typing tests assert the relation chain is accepted as an `AnySelector` key, and that contract is unchanged.

### `apps/website/src/Demo.tsx`

No changes needed. The demo only uses `.is.ancestor` and `.is.descendant`, which keep their names. Useful side-effect: visual verification that the cascade behavior in the running demo doesn't regress when the specificity drops to 0,1,0.

## Testing

Three layers, in order of how directly they exercise the production path:

### 1. Unit tests for `marker-registry.ts`

[`packages/bearbones-vite/tests/marker-registry.test.ts`](packages/bearbones-vite/tests/marker-registry.test.ts) is updated:

- Existing `ancestor`, `descendant`, `sibling` tests are rewritten against the new selector shapes. The `sibling` test is renamed to `siblingAny`.
- New `siblingBefore` and `siblingAfter` tests assert the exact emitted strings.
- The "every & in input is substituted" test ([marker-registry.test.ts:44–48](packages/bearbones-vite/tests/marker-registry.test.ts:44)) is updated to assert against the new `:where(...)`-wrapped output (substitution behavior is unchanged; only the wrap is added).
- The "throws when condValue lacks `&`" test ([marker-registry.test.ts:56–58](packages/bearbones-vite/tests/marker-registry.test.ts:56)) stays as-is (the error path is upstream of the relation switch).
- A "specificity contract" test feeds each emitted selector through a real CSS specificity calculator and asserts the result equals `(0, 1, 0)` — exactly one class, matching a plain utility. This is the load-bearing assertion: it catches missing `:where()` wrapping, wrapper misplacement, and any future shape edit that bumps specificity, all in one check. Implementation:
  1. Add `@bramus/specificity` (`^2.4.2`) as a dev-dependency of `@bearbones/vite`. It's a maintained ESM package by the author of the canonical CSS Specificity Calculator.
  2. For each relation in `MARKER_RELATIONS`, call `buildRelationSelector(anchor, "&:hover", relation)`.
  3. Substitute the trailing `&` (the styled-element placeholder) with a sentinel class `.target` to produce a real CSS selector — mimics what `postcss-nested` does at Panda's emit time. Use a global regex on the `&` token so multi-`&` shapes like `siblingAny` are fully substituted.
  4. Pass the substituted selector to `Specificity.calculate()`. For comma-joined selectors the API returns one specificity per branch — assert _every_ branch reports `(0, 1, 0)`.
- The `endsWith(" &")` / `startsWith("&")` Panda-compatibility test is updated to cover all five relations and document which Panda nesting type each maps to.

### 2. Unit tests for `transform.ts`

[`packages/bearbones-vite/tests/transform.test.ts`](packages/bearbones-vite/tests/transform.test.ts) is updated:

- The three regex assertions pinning the old `.is.ancestor`, `.is.descendant`, `.is.sibling` shapes ([transform.test.ts:91, :191, :207, :222, :237 area](packages/bearbones-vite/tests/transform.test.ts:91)) are rewritten against the new strings. The `sibling` test is renamed to `siblingAny`.
- The marker-record synthesis test ([transform.test.ts:80–93](packages/bearbones-vite/tests/transform.test.ts:80)) is updated to expect the new wrapped `_hover.is.ancestor` shape.
- Two new tests cover `.is.siblingBefore` and `.is.siblingAfter` lowering — call-form (`m("&:hover").is.<rel>`) is enough; the underscore form is exercised by the existing `_focusVisible.is.descendant` pattern adapted as needed.
- The `&`-substitution tests ([transform.test.ts:262–294](packages/bearbones-vite/tests/transform.test.ts:262)) are updated against the wrapped shapes; substitution semantics are unchanged.
- The "throws when condValue lacks `&`" test ([transform.test.ts:296–307](packages/bearbones-vite/tests/transform.test.ts:296)) stays as-is.

### 3. Codegen-patch snapshot

[`packages/bearbones-vite/tests/codegen-patch.test.ts`](packages/bearbones-vite/tests/codegen-patch.test.ts) — the existing snapshot is regenerated to capture the five-entry phantom-literal `is` shape. Since each entry is a phantom literal (not a real selector), the only thing this test verifies is the structural type emit, which is the existing contract.

### 4. End-to-end via the existing website

`vp run --filter website codegen && vp check && vp run -r test` exercises the full pipeline. The `__type-tests__/css-typing.ts` rename ensures TypeScript still accepts the chain key. The website demo continues to render and visually demonstrates ancestor/descendant relations — running it post-change confirms that dropping specificity to 0,1,0 doesn't regress the cascade in real use.

## Edge cases & risks

- **`siblingAny` selector is comma-joined.** Panda classifies it as `combinator-nesting` (the comma string contains `&` but neither starts with `&` nor ends with ` &`). `postcss-nested` substitutes `&` independently in each comma-separated half. Verified by reading [`@pandacss/core` `expandNestedCss`](node_modules/.pnpm/@pandacss+core@1.10.0/node_modules/@pandacss/core/dist/index.js); the website integration check is the empirical confirmation.

- **Browser support for `:where()` and `:has()`.** Both shipped in all evergreen browsers in early 2023. `:has()` is already required by the existing `descendant` relation. `:where()` has broader support than `:has()`; if `:has()` works, `:where()` works.

- **Selector escaping.** Modifier strings are concatenated raw onto the anchor class (unchanged from current behavior — same `&`-substitution model). Garbage in, garbage out. Existing constraint, not a regression.

- **Phantom-literal collisions.** The five phantom suffixes (`_a`, `_d`, `_sb`, `_sa`, `_san`) are unique per relation, so two distinct relations on the same `(Id, Cond)` pair don't collide as object keys. The tail-`&` placement (parent- vs self-nesting) doesn't matter to TypeScript — it only matters to the runtime, which never sees the phantom literals.

- **Specificity calculator for `:has()` arguments.** `@bramus/specificity` correctly handles `:has()` (treats it as the highest-specificity argument like `:not()`/`:is()`). Inside our `:where()` wrap, `:has()` contributes 0 anyway, so this is a non-issue. Verified by spot-checking the package's test fixtures.

## Out of scope

- **`stylex.defineMarker` / custom marker classes.** StyleX lets users define multiple marker classes per project. Bearbones already does this implicitly — every `marker(id)` call has its own hashed anchor — so this is functionally covered, just under a different surface.
- **Migration tooling for the `sibling` rename.** One internal call site, renamed by hand. No codemod needed.
- **`stylex.when.media` / `stylex.when.context` analogues.** Out of scope. The relations table is structured so future relations could be added by adding rows.

## Files touched

- `packages/bearbones-vite/src/marker-registry.ts` — replace `switch` with `RELATION_SELECTORS` table, expand `MARKER_RELATIONS`, update `buildRelationSelector` to delegate to the table
- `packages/bearbones-vite/src/transform.ts` — derive runtime helper and `renderMarkerRecord` from the new table
- `packages/bearbones-vite/src/codegen-patch.ts` — expand `renderMarkerTypes` `is` shape from three to five phantom-literal entries
- `packages/bearbones-vite/tests/marker-registry.test.ts` — update existing tests, add two new, add specificity-contract assertion via `@bramus/specificity`
- `packages/bearbones-vite/tests/transform.test.ts` — update existing assertions, add two new lowering tests
- `packages/bearbones-vite/tests/codegen-patch.test.ts.snap` — regenerate snapshot for new `is` shape
- `packages/bearbones-vite/package.json` — add `@bramus/specificity` (`^2.4.2`) to `devDependencies`
- `apps/website/src/__type-tests__/css-typing.ts` — rename `.is.sibling` → `.is.siblingAny` on line 55
