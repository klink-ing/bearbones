/**
 * Local declaration shim for `@bramus/specificity`. Upstream ships JS-only.
 * We rely on the small subset used by the marker specificity-contract test:
 * `Specificity.calculate(selector)` returns one entry per comma-branch, each
 * with `.toArray()` (the `[a, b, c]` triple) and `.selectorString()`.
 */
declare module "@bramus/specificity" {
  export interface SpecificityResult {
    readonly a: number;
    readonly b: number;
    readonly c: number;
    toArray(): readonly [number, number, number];
    toString(): string;
    selectorString(): string;
  }

  // The default export is the Specificity class with static helpers.
  const Specificity: {
    calculate(selector: string): SpecificityResult[];
  };
  export default Specificity;
}
