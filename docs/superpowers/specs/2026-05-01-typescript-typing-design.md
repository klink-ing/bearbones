# Bearbones TypeScript typing — design

**Status:** Approved design, pre-implementation
**Date:** 2026-05-01

## Problem

Today, calling `css('p-4', ...)` from a Panda-generated `css()` function does not type-check. Panda's `css()` accepts only `SystemStyleObject` shapes, so utility strings are rejected. The website demo works around this with a manual cast in [apps/website/src/Demo.tsx](apps/website/src/Demo.tsx):

```ts
type TypedCss = (...args: BearbonesStyleInput[]) => string;
const css = _css as unknown as TypedCss;
```

Two problems with the cast:

1. **Every consumer must repeat it.** It's not a real integration; it's a per-call-site escape hatch.
2. **The cast destroys Panda's type information on the object form.** `BearbonesStyleInput` falls back to `Record<string, unknown>` for the object branch, so `css({ padding: 'totally-bogus' })` type-checks even though it's wrong.

The goal is for the host project's existing `css()` import to natively accept utility strings — no cast, no degraded object typing — by patching Panda's emitted `css.d.ts` during codegen.

## Approach

Add a `codegen:prepare` handler to `bearbonesHooks()` in `@bearbones/vite`. The handler intercepts the artifact array Panda is about to write to disk, finds the `css.d.ts` artifact, and rewrites the `Styles` type alias to point at a widened recursive type that also accepts bearbones utility strings. The rewrite happens in memory before Panda writes anything, so the user-facing experience is "the types just work" with no extra files in `styled-system/` and nothing to gitignore.

The runtime is untouched — Panda's `css()` function ships unchanged. Only the `.d.ts` is patched.

### Why `codegen:prepare`

Per [Panda's hook docs](https://panda-css.com/docs/concepts/hooks):

> **codegen:prepare** — "Called right before writing the codegen files to disk. You can use this hook to tweak the codegen files before they are written to disk."

It runs after `config:resolved` and before any source files are written. That's exactly the window we need: Panda's resolved tokens are available (so we can derive `BearbonesUtilityName`), and we can mutate the about-to-be-written types freely.

### Why not the alternatives

- **Generate a sibling `styled-system-bearbones/`.** Forces the user to gitignore another folder and changes the import path consumers use. Adds one more concept to the mental model.
- **TS module augmentation on `'../styled-system/css'`.** Augmenting a `const css: CssFunction` declaration via declaration merging is awkward — TS only merges interfaces, not function-typed `const`s. Would require Panda to emit the signature differently.
- **Generate a separate `bearbones.d.ts` file inside `styled-system/`.** Requires `tsconfig` work and a re-export shim. The `codegen:prepare` patch is strictly less work for the same outcome.

## Type shape

Panda's existing types (verbatim, from [chakra-ui/panda](https://github.com/chakra-ui/panda/blob/main/packages/types/src/conditions.ts)):

```ts
// Panda — conditions.ts
export type Nested<P> =
  | (P & {
      [K in Selectors]?: Nested<P>;
    } & {
      [K in AnySelector]?: Nested<P>;
    })
  | {
      [K in Condition]?: Nested<P>;
    };

// Panda — system-types.ts
export type SystemStyleObject = Nested<(SystemProperties | GenericProperties) & CssVarProperties>;

// Panda — emitted styled-system/css/css.d.ts
type Styles = SystemStyleObject | undefined | null | false;
```

The bearbones-patched output adds two declarations and rewrites one line:

```ts
// --- INJECTED by bearbonesHooks() codegen:prepare ---

export type BearbonesUtilityName =
  | 'p-0' | 'p-0.5' | /* ... derived from utility-map.ts ... */
  | 'flex' | 'rounded-md' | 'bg-blue-500'

// Mirrors Panda's Nested<P> with two changes:
//   1. The whole tree may also be a BearbonesUtilityName.
//   2. Every condition / selector value position also accepts a utility
//      string or an array of styles. CSS property values (P) are untouched
//      — they remain strict via Panda's existing typing.
export type BearbonesNested<P> =
  | BearbonesUtilityName
  | (P & {
      [K in Selectors]?: BearbonesNested<P> | readonly BearbonesNested<P>[]
    } & {
      [K in AnySelector]?: BearbonesNested<P> | readonly BearbonesNested<P>[]
    })
  | {
      [K in Condition]?: BearbonesNested<P> | readonly BearbonesNested<P>[]
    }

export type BearbonesSystemStyleObject =
  BearbonesNested<(SystemProperties | GenericProperties) & CssVarProperties>

// --- PATCHED line ---
type Styles = BearbonesSystemStyleObject | undefined | null | false
```

Marker relational keys (`.bearbones-marker-card_<hash>:is(:hover, [data-hover]) &`, etc.) are _not_ a separate template-literal type and are _not_ registered in Panda's `Conditions` interface. They're raw CSS selectors that Panda's `parseCondition` recognizes natively; the bearbones recursive type accepts them via the `[K in AnySelector]` branch. See "When-style relational modifiers" below.

### Behavioural diff

| Call site                                                   | Base Panda                                      | Bearbones-patched                                           |
| ----------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| `css('p-4')`                                                | ❌ string not assignable to `SystemStyleObject` | ✅ `'p-4'` ∈ `BearbonesUtilityName`                         |
| `css('p-44')` (typo)                                        | ❌                                              | ❌ — typo not in union                                      |
| `css({ padding: '4' })`                                     | ✅                                              | ✅ — property side untouched                                |
| `css({ padding: 'p-4' })`                                   | ❌                                              | ❌ — utility strings rejected as property values            |
| `css({ _hover: ['bg-blue-500', 'text-white'] })`            | ❌ array shape doesn't match                    | ✅ — condition value can be `readonly BearbonesNested<P>[]` |
| `css({ _hover: { padding: '8' } })`                         | ✅                                              | ✅ — recursion preserves Panda                              |
| `css({ [cardMarker._hover.is.ancestor]: 'text-blue-500' })` | ❌ key not assignable                           | ✅ — chain returns a raw selector (matches `AnySelector`)   |
| `css({ '&:focus-within': 'p-4' })`                          | ❌                                              | ✅ — selector value position is `BearbonesNested<P>`        |

## Components

### `@bearbones/vite` — new `codegen-patch.ts`

Single file owning the patch logic. Exports one function:

```ts
export function patchCssArtifact(content: string, utilityNames: readonly string[]): string;
```

Pure function: takes the original `css.d.ts` source and the list of utility names, returns the patched source. Pure-function shape makes it trivially testable in isolation.

The patch operates by string replacement against well-anchored markers in Panda's emitted code (the `type Styles =` line). If the marker is not found, the function throws a clear error referencing the upstream Panda format change — the build fails loudly rather than producing wrong types silently.

### `@bearbones/vite` — extended `bearbonesHooks()`

Existing `bearbonesHooks()` (in `index.ts`) gains a `codegen:prepare` entry. The handler:

1. Walks the `artifacts` array Panda hands it.
2. Finds the artifact whose file is `css/css.d.ts` (and any other `.d.ts` files that need patching — to be confirmed during prototype: likely just the one, but `cva.d.ts`, `sva.d.ts`, and `index.d.ts` may need re-exports).
3. Calls `patchCssArtifact(content, listUtilities())` on its content.
4. Returns the artifact array with the patched content swapped in.

The hook does _not_ mutate the input artifact array; it returns a new array per Panda's hook contract.

### `@bearbones/codegen` — deleted

The package is removed entirely:

- `packages/bearbones-codegen/` directory deleted.
- `pnpm-workspace.yaml` entry removed.
- `apps/website/package.json` dependency on `@bearbones/codegen` removed.
- README "Repository layout" section updated.
- README "Follow-ups" section: the type-augmentation follow-up is removed; the facade rewriting and wider utility vocabulary follow-ups remain.

The existing `generateTypes()` logic in `packages/bearbones-codegen/src/index.ts` is _not_ ported. It built a different shape (a closed `BearbonesConditionObject` etc.) that the new design supersedes.

### `apps/website/src/Demo.tsx` — cast removed

The seven-line `TypedCss` cast block at the top of the file is deleted. The `BearbonesStyleInput` symbol is also dropped from the `bearbones` import on line 6, since nothing else in the file references it. `css` is imported directly from `../styled-system/css` and used unchanged. This becomes the de facto integration test: if `pnpm run check` (which runs `tsc` on the website) passes after the cast is removed, the patch works end-to-end.

### `packages/bearbones/src/index.ts` — type-only exports cleaned up

The current re-exports of `BearbonesUtilityName`, `BearbonesStyleInput`, `BearbonesConditionObject`, `BearbonesMarkerRuntime` from `bearbones` are evaluated:

- `BearbonesUtilityName`: keep — useful for users who want to type a function arg as "a bearbones utility name". Source of truth stays in `@bearbones/vite/utility-map.ts`.
- `BearbonesStyleInput`, `BearbonesConditionObject`: delete — these existed only to support the manual cast, which is gone.
- `BearbonesMarkerRuntime`: keep — the runtime shape returned from `marker()`.

After deleting `BearbonesConditionObject`, also remove the now-orphaned `import type { BearbonesUtilityName }` line that fed it (currently line 92 of `packages/bearbones/src/index.ts`). The top-level `export type { BearbonesUtilityName } from "@bearbones/vite"` re-export stays.

## Testing

Three layers, in order of how directly they exercise the production path:

### 1. Unit tests for `patchCssArtifact`

In `packages/bearbones-vite/tests/`. Feed the function a fixture string mirroring Panda's actual emitted `css.d.ts` (captured from a real `panda codegen` run, checked in as a fixture). Assert:

- Patched output contains the injected `BearbonesUtilityName`, `BearbonesNested`, `BearbonesSystemStyleObject` declarations.
- Patched output's `type Styles` line points at `BearbonesSystemStyleObject`.
- Calling with an unmodified-but-different fixture (where the `type Styles` marker is missing) throws a recognizable error.
- Snapshot the full patched output to catch unintended drift.

### 2. Type-level tests in the website app

A new file `apps/website/src/__type-tests__/css-typing.ts` (excluded from the runtime bundle but included by `tsc`) using `// @ts-expect-error` and assignability checks:

```ts
// Valid forms
css("p-4");
css("p-4", "bg-blue-500", { padding: "8" });
css({ _hover: ["bg-blue-500", "text-white"] });
css({ _hover: { padding: "8" } });
css({ [cardMarker._hover.is.ancestor]: "text-blue-500" });
css({ "&:focus-within": ["p-4", "bg-blue-500"] });

// @ts-expect-error — typo'd utility name
css("p-44");
// @ts-expect-error — utility string not allowed as property value
css({ padding: "p-4" });
// @ts-expect-error — unknown utility prefix
css("ypg-4");
```

`pnpm run check` runs `tsc` against this file as part of CI, catching regressions in either the patch or the utility-name derivation.

### 3. End-to-end via the existing demo

Removing the `TypedCss` cast from `Demo.tsx` and getting a clean `tsc` is itself the integration test. The demo already exercises every relevant call shape (top-level utilities, mixed object form, marker conditions, `_hover` arrays).

## Edge cases & risks

- **Utility-name list ordering.** `BearbonesUtilityName` is a string-literal union; TS can hit recursion / instantiation depth limits with large unions. The MVP vocabulary is ~150 names, comfortably under any limit, but if the vocabulary grows past ~5000 entries this could become an issue. Tracked as future work, not a blocker.

- **Panda format drift.** If a future Panda release changes the emitted `css.d.ts` shape (renames `Styles`, restructures the file), the marker-based replacement will fail. The thrown error names the missing marker explicitly so the diagnosis is one Panda changelog read away. The unit-test fixture catches this in CI when the bearbones-vite package is rebuilt against a new Panda.

- **No prescan, no inter-build state.** The marker registry is populated lazily by the transform as it encounters `marker(id)` declarations and chain usage sites. There's nothing to keep in sync across builds — each `css()` call is self-contained and Panda extracts whatever raw selectors are literally in the source.

- **Implementation prototype required for `SystemProperties` import path.** The patched type references `SystemProperties`, `GenericProperties`, `CssVarProperties`, `Selectors`, `AnySelector`, `Condition` — these all need to be importable from somewhere within the `styled-system/` tree. Verifying their actual emitted module paths (and adding any necessary `import` lines to the patched `css.d.ts`) is the first concrete step of implementation. If any of these aren't cleanly accessible, the spec gets a small revision describing what we re-emit inline.

## Out of scope

- **Facade rewriting.** `import { css } from 'bearbones'` → `import { css } from '../styled-system/css'`. Tracked separately in the README follow-ups; the typing change works regardless of which path consumers import from.
- **Wider utility vocabulary.** Adding more entries to `utility-map.ts` is a separate, independent change. The type derivation already picks them up automatically.
- **Deriving `BearbonesUtilityName` from the resolved Panda preset.** The README mentions this as a long-term direction. For now, the source of truth stays in `utility-map.ts`.
- **`cva` / `sva` typing.** Same patching approach would apply, but the demo doesn't exercise these and the MVP doesn't need them. Tracked as future work; the `codegen-patch.ts` module is structured so each artifact gets its own patch function.

## Files touched

- `packages/bearbones-vite/src/codegen-patch.ts` — new, ~100 lines
- `packages/bearbones-vite/src/index.ts` — extend `bearbonesHooks()` with `codegen:prepare`
- `packages/bearbones-vite/tests/codegen-patch.test.ts` — new
- `packages/bearbones-vite/tests/fixtures/panda-css.d.ts` — new fixture
- `packages/bearbones/src/index.ts` — remove `BearbonesStyleInput`, `BearbonesConditionObject`
- `packages/bearbones-codegen/` — deleted
- `pnpm-workspace.yaml` — drop `bearbones-codegen` entry
- `apps/website/package.json` — drop `@bearbones/codegen` dep
- `apps/website/src/Demo.tsx` — remove `TypedCss` cast
- `apps/website/src/__type-tests__/css-typing.ts` — new
- `README.md` — update "Repository layout" and "Follow-ups"

## When-style relational modifiers

The marker primitive extends with a StyleX-style `when` API: `marker(':sel').is.<relation>` (call form) and `marker._<state>.is.<relation>` (typed shortcut). The user can apply _any_ CSS-fragment modifier — not just the five known pseudo-states (`hover`, `focus`, `focusVisible`, `active`, `disabled`) — without pre-declaring it anywhere.

### API

```ts
const containerMarker = marker("container");

css({
  // call form: arbitrary CSS-fragment modifier
  [containerMarker(":has(.error)").is.ancestor]: { color: "red" },
  [containerMarker("[data-state=open]").is.sibling]: { opacity: 1 },
  // typed shortcut form: same five known states, but as a builder
  [containerMarker._focusVisible.is.descendant]: { outline: "2px solid" },
});
```

Relations: `ancestor`, `descendant`, `sibling`. No default — explicit `.is.<relation>` is required.

### How it works

There is no condition registration, no prescan, no `keyof Conditions` augmentation. The chain compiles to a **raw CSS selector string** that Panda's `parseCondition` accepts directly:

For anchor `A = .bearbones-marker-<suffix>` and modifier `M`:

| Relation     | Lowered key      | Panda's classification |
| ------------ | ---------------- | ---------------------- |
| `ancestor`   | `AM &`           | `parent-nesting`       |
| `descendant` | `&:has(AM)`      | `self-nesting`         |
| `sibling`    | `& ~ AM, AM ~ &` | `combinator-nesting`   |

All three match Panda's `parseCondition` ([`@pandacss/core@1.10.0/dist/index.js:298-320`](../../../node_modules/.pnpm/@pandacss+core@1.10.0/node_modules/@pandacss/core/dist/index.js)) — so Panda treats them as raw selectors at extraction time and emits CSS rules for them without anything having been pre-registered.

### Lowering

The `parser:before` transform recognizes the same two chain shapes as computed keys inside `css({…})` / `cva({…})` / `sva({…})` argument objects:

- `<binding>(LITERAL).is.<relation>` — call form. Modifier must be a string literal (or non-templated template literal); dynamic args are skipped, leaving the chain in source as authored.
- `<binding>._<state>.is.<relation>` — underscore form. State must be one of the five fixed pseudo-state names; the modifier is the matching `STATE_PSEUDO[state]` selector.

Each match composes the raw selector via `buildRelationSelector(anchorClass, modifier, relation)` and substitutes it into the lowered object literal as the key. No condition lookup, no hashing, no global walk.

The synthesized marker record is `Object.assign(fn, { …builders })`. The function half is `(m) => __bearbones_relations(m, anchorClass)`, where `__bearbones_relations` is a tiny inlined helper that runs the same string composition `buildRelationSelector` does — so variable-bound chains (`const k = m(':sel').is.ancestor`) compute byte-identical raw selectors at runtime.

### Typing

`codegen-patch.ts` emits one entry per declared marker into `BearbonesMarkerRegistry`. Each entry intersects:

- A wide-string call signature `(selector: string) => { is: { ancestor: \`.bearbones-marker-<suffix>${string} &\`; descendant: \`&:has(.bearbones-marker-<suffix>${string})\`; sibling: \`& ~ .bearbones-marker-<suffix>${string}, .bearbones-marker-<suffix>${string} ~ &\` } }`— template-literal-typed raw selectors anchored at the marker's hashed class. Sibling is comma-emitted starting with`&`so the string matches`AnySelector`'s `&${string}` pattern.
- An object half with `anchor: <literal>` and one literal-typed `_<state>` builder per known pseudo-state.

Each variant of the `is` builder return type matches Panda's `AnySelector` ([`@pandacss/types/selectors.d.ts:57`](../../../node_modules/.pnpm/@pandacss+types@1.10.0/node_modules/@pandacss/types/dist/selectors.d.ts) — `` `${string}&` | `&${string}` | `@${AtRuleType}${string}` ``), so the chain result is accepted as a computed key in `BearbonesNestedObject<P>`'s `[K in AnySelector]` branch with no additional augmentation.

### Edge cases

- **Dynamic modifier strings:** the transform requires a `StringLiteral` to lower. Anything else is left in source as authored; at runtime the helper produces a working raw selector and Panda's runtime `css()` accepts it, but build-time static extraction misses it (same edge case as any non-statically-extractable Panda input).
- **Selector escaping:** modifier is concatenated raw onto the anchor class. Garbage in, garbage out — the build doesn't validate.
- **Cross-file marker imports:** the transform's `resolveImportedMarker` lazy path resolves an imported binding back to its `marker(id)` declaration on demand. No precomputation needed.
