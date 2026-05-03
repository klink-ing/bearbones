/**
 * Type-level tests for the bearbones-augmented `css()` signature.
 *
 * This file is type-checked by `tsc` as part of the website build but never
 * executed. Each block exercises a specific accepted or rejected shape from
 * the spec's behavioural diff. If the patch in `@bearbones/vite/codegen-patch`
 * regresses, one of the `@ts-expect-error` directives stops matching and the
 * build fails loudly.
 *
 * Note: this file is *also* run through the bearbones lowering transform, so
 * literal utility strings here are rewritten before they reach the browser.
 * That's fine — we're testing the static type surface, not runtime behavior.
 */

import { css } from "../../styled-system/css";
import { cardMarker } from "../markers.ts";

// --- Valid forms --------------------------------------------------------

// Single utility string at top level.
css("p-4");

// Multiple utility strings + Panda style object mixed.
css("p-4", "bg-blue-500", { padding: "8" });

// Utility strings inside arrays under a Panda condition.
css({ _hover: ["bg-blue-500", "text-white"] });

// Nested Panda style object under a condition (recursion preserves Panda).
css({ _hover: { padding: "8" } });

// Bearbones marker relational condition key — typed shortcut form. The
// `_hover` builder yields `.is.{ancestor,descendant,siblingBefore,siblingAfter,siblingAny}`;
// each lands as a `:where(...)`-wrapped raw selector matching StyleX's
// `when.*` specificity contract (the marker observation contributes 0; only
// the styled element's own class counts).
css({ [cardMarker._hover.is.ancestor]: "text-blue-500" });

// Utility string under an arbitrary nested selector.
css({ "&:focus-within": "p-4" });

// Array of utility strings under an arbitrary nested selector.
css({ "&:focus-within": ["p-4", "bg-blue-500"] });

// Marker call form: arbitrary Panda condition value with explicit relation.
// `&` is mandatory and is substituted with the marker's anchor selector.
css({ [cardMarker("&:has(.flag-error)").is.ancestor]: "text-red-500" });

// Marker underscore form: typed shortcut against a registered Panda
// condition with explicit relation. The condition value comes from
// `panda.config.conditions` (with preset-base defaults plus user
// extensions) and is substituted into the relation at lower-time.
css({ [cardMarker._focusVisible.is.descendant]: "text-blue-500" });

// Any-sibling relation works too — the comma-joined StyleX-style shape that
// matches both directions of sibling relationship.
css({ [cardMarker("&:focus-within").is.siblingAny]: "text-gray-700" });

// Parent-nesting condition value — marker is descendant of state-bearing element.
css({ [cardMarker("[data-state=open] &").is.descendant]: "text-blue-500" });

// Mixing marker computed-keys with literal CSS properties in one object
// works: relation types are concrete literal templates parameterized on
// Id + Cond (no `${string}` widening), so TS preserves them as named
// property keys instead of collapsing to a string index signature.
css({
  [cardMarker("& > *").is.descendant]: "text-red-500",
  borderWidth: 1,
});

// Underscore form mixed with sibling property — same property keeps literal
// inference; TypeScript treats the marker chain key like any other property.
css({
  [cardMarker._hover.is.ancestor]: "text-blue-500",
  padding: "4",
});

// --- Literal-string evaluation -----------------------------------------
//
// Every `is.<relation>` chain evaluates at the *type level* to the exact
// raw selector string the runtime emits, modulo the marker hash slot
// (which TypeScript cannot compute — the runtime uses an 8-hex SHA1 of
// `(id, modulePath)`; the type uses the literal placeholder `<HASH>`).
//
// We pin the literal types in both directions to verify the recursive
// `BearbonesSubstituteAmp` substitution stays concrete and doesn't widen
// to `${string}` at any point.

// Call form, single `&`.
const _ancestorCall: ":where(.bearbones-marker-card_<HASH>:has(.flag-error)) &" =
  cardMarker("&:has(.flag-error)").is.ancestor;
void _ancestorCall;

// Underscore form picks up the resolved condition value from the conditions
// stash (preset-base default for `_hover` is `&:is(:hover, [data-hover])`).
const _ancestorHover: ":where(.bearbones-marker-card_<HASH>:is(:hover, [data-hover])) &" =
  cardMarker._hover.is.ancestor;
void _ancestorHover;

// Descendant relation — self-nesting form, `&` at the front.
const _descendantHover: "&:where(:has(.bearbones-marker-card_<HASH>:is(:hover, [data-hover])))" =
  cardMarker._hover.is.descendant;
void _descendantHover;

// Sibling-before, sibling-after, sibling-any — the three new relations.
const _siblingBefore: ":where(.bearbones-marker-card_<HASH>:focus-within) ~ &" =
  cardMarker("&:focus-within").is.siblingBefore;
void _siblingBefore;

const _siblingAfter: "&:where(:has(~ .bearbones-marker-card_<HASH>:focus-within))" =
  cardMarker("&:focus-within").is.siblingAfter;
void _siblingAfter;

// Comma-joined two-branch shape. The `&`-prefixed branch comes first so the
// literal type satisfies Panda's `AnySelector` (`${string}&` | `&${string}`).
const _siblingAny: "&:where(:has(~ .bearbones-marker-card_<HASH>:focus-within)), :where(.bearbones-marker-card_<HASH>:focus-within) ~ &" =
  cardMarker("&:focus-within").is.siblingAny;
void _siblingAny;

// Multi-`&` condition value: every `&` is substituted independently, so the
// observer contains the anchor twice.
const _multiAmp: ":where(.foo:has(.bearbones-marker-card_<HASH>) ~ .bearbones-marker-card_<HASH>) &" =
  cardMarker(".foo:has(&) ~ &").is.ancestor;
void _multiAmp;

// Parent-nesting condition value (`& :child` style) — substitution leaves
// the anchor in the leading position rather than the trailing one.
const _parentNesting: "&:where(:has([data-state=open] .bearbones-marker-card_<HASH>))" =
  cardMarker("[data-state=open] &").is.descendant;
void _parentNesting;

// --- Rejected forms -----------------------------------------------------

// Typo'd utility name — `13` is not a Panda spacing token (the scale jumps
// from 12 to 14), so `p-13` is not a member of BearbonesUtilityName.
// @ts-expect-error
css("p-13");

// Unknown utility prefix.
// @ts-expect-error
css("ypg-4");

// Note on CSS property values: Panda intentionally types every CSS property
// value as `ConditionalValue<CssProperties[K] | AnyString>` where `AnyString =
// (string & {})`, accepting arbitrary strings as a fallback. That means
// `css({ padding: 'p-4' })` type-checks even though the value is meaningless
// — by Panda's design, not ours. Rejecting it would require overriding Panda's
// property typing, which is out of scope. The bearbones-typed surface only
// guarantees utility-string acceptance at TOP-LEVEL args and CONDITION/SELECTOR
// value positions; it inherits Panda's permissive property-value typing
// unchanged.
