// Demo exercising the bearbones primitives end-to-end. Once the parser:before
// hook fires, every `css('p-4', ...)` call has been lowered to Panda's native
// object form before the extractor sees it, so the resulting CSS file contains
// the expected atomic classes.
//
// The bearbones `codegen:prepare` hook patches Panda's emitted `css.d.ts` so
// `css()` accepts utility strings + group condition keys natively — no cast
// needed at the call site.
import { css } from "../styled-system/css";
import { cx } from "bearbones";
import { cardGroup, rowGroup } from "./groups.ts";

export function Demo() {
  return (
    <main className={css("p-8", "gap-4", "flex")}>
      <h1 className={css("text-2xl", "font-bold")}>bearbones demo</h1>

      {/* Group anchor + child styling itself based on parent's hover. */}
      <article
        className={cx(
          css("p-4", "p-8", "rounded-md", "shadow-sm", "bg-white", {
            _hover: ["bg-blue-800", "text-white"],
          }),
          cardGroup.anchor,
        )}
      >
        <h2
          className={css("text-lg", "font-bold", {
            [cardGroup.hover]: "text-blue-500",
          })}
        >
          Card title
        </h2>
        <p
          className={css("text-sm", "text-gray-500", {
            [cardGroup.hover]: "text-gray-700",
          })}
        >
          Hover the card to see both lines change colour.
        </p>
      </article>

      {/* Multiple nested groups: span responds to either ancestor independently. */}
      <div className={cx(css("p-2", "rounded-md", "bg-gray-100"), rowGroup.anchor)}>
        <article className={cx(css("p-4", "rounded-md", "bg-white"), cardGroup.anchor)}>
          <span
            className={css("text-sm", {
              [rowGroup.hover]: "text-blue-500",
              [cardGroup.hover]: "text-red-500",
            })}
          >
            Hovers respond to either ancestor independently.
          </span>
        </article>
      </div>

      {/* Object form for one-off styles that are outside the utility vocabulary. */}
      <div
        className={css({
          gap: "calc(var(--spacing-4) + 0.5rem)",
          padding: "1rem",
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
    </main>
  );
}
