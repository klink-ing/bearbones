// Demo exercising the bearbones primitives end-to-end. Once the parser:before
// hook fires, every `css('p-4', ...)` call has been lowered to Panda's native
// object form before the extractor sees it, so the resulting CSS file contains
// the expected atomic classes.
//
// The bearbones `codegen:prepare` hook patches Panda's emitted `css.d.ts` so
// `css()` accepts utility strings + marker condition keys natively — no cast
// needed at the call site.
import { css } from "../styled-system/css";
import { cx } from "bearbones";
import { cardMarker, rowMarker } from "./markers.ts";

export function Demo() {
  return (
    <main className={css("p-8", "gap-4", "flex")}>
      <h1 className={css("text-2xl", "font-bold")}>bearbones demo</h1>

      {/* Marker anchor + child styling itself based on parent's hover. */}
      <article
        className={cx(
          css("p-4", "p-8", "rounded-md", "shadow-sm", "bg-white", {
            _hover: ["bg-blue-800", "text-white"],
          }),
          cardMarker.anchor,
        )}
      >
        <h2
          className={css("text-lg", "font-bold", {
            [cardMarker.hover]: "text-blue-500",
          })}
        >
          Card title
        </h2>
        <p
          className={css("text-sm", "text-gray-500", {
            [cardMarker.hover]: "text-gray-700",
          })}
        >
          Hover the card to see both lines change colour.
        </p>
      </article>

      {/* Multiple nested markers: span responds to either ancestor independently. */}
      <div className={cx(css("p-2", "rounded-md", "bg-gray-100"), rowMarker.anchor)}>
        <article className={cx(css("p-4", "rounded-md", "bg-white"), cardMarker.anchor)}>
          <span
            className={css("text-sm", {
              [rowMarker.hover]: "text-blue-500",
              [cardMarker.hover]: "text-red-500",
            })}
          >
            Hovers respond to either ancestor independently.
          </span>
        </article>
      </div>
      {/* Object form for one-off styles that are outside the utility vocabulary. */}
      <div
        className={css({
          gap: "[calc(var(--spacing-4) + 0.5rem)]",
          padding: "[1rem]",
          backgroundColor: "blue.50",
          borderRadius: "md",
        })}
      >
        Object-form styles work alongside utility strings.
      </div>

      <div
        className={css("p-4", "rounded-md", "bg-gray-500", {
          _hover: ["bg-red-800", "text-white", { bg: "blue.800" }],
        })}
      >
        hover background color should be blue
      </div>

      {/*
        StyleX-style `when` chains. Both shapes lower to literal Panda
        condition keys at build time; prescan registers the (modifier,
        relation) pairs so Panda's extractor emits matching CSS.
      */}
      <article className={cx(css("p-4", "rounded-md", "bg-gray-100"), cardMarker.anchor)}>
        <p
          className={css("text-sm", {
            // Underscore form: explicit `.is.<relation>` against a known state.
            [cardMarker._focusVisible.is.descendant]: "text-blue-500",
          })}
        >
          Tab here — when this paragraph receives :focus-visible (descendant relation), the
          card-marker ancestor's text turns blue.
        </p>
        <p
          className={css("text-sm", {
            // Call form: arbitrary CSS-fragment modifier.
            [cardMarker(":has(.flag-error)").is.ancestor]: "text-red-500",
          })}
          tabIndex={0}
        >
          Adding `.flag-error` anywhere inside the card flips this line red via `:has(...)`.
        </p>
      </article>
    </main>
  );
}
