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
// `_hover` builder yields `.is.{ancestor,descendant,sibling}`; each lands as
// a literal condition key registered by the prescan into Panda's Conditions
// interface.
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

// Sibling relation works too.
css({ [cardMarker("&:focus-within").is.sibling]: "text-gray-700" });

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
