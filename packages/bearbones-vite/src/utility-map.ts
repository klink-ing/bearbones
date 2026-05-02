/**
 * Utility-string vocabulary for the bearbones MVP.
 *
 * Each entry maps a Tailwind v4-flavored utility name to the Panda style-object
 * fragment that produces the same atomic class. The transform uses this table
 * during `parser:before` to lower `css('p-4')` into `css({ p: 4 })`.
 *
 * The scale-driven entries (spacing, colors, font sizes, font weights, radii,
 * shadows) are NOT hard-coded — they're derived from the host project's
 * resolved Panda tokens, populated via `populateUtilityMapFromTokens()` from
 * the `config:resolved` hook. This keeps utility shorthands automatically in
 * sync with whatever tokens Panda ships (defaults + user preset extensions);
 * adding a new spacing token to your Panda preset means the matching `p-X` /
 * `m-X` / `gap-X` shorthand becomes valid without any change here.
 *
 * The fixed pieces — Tailwind prefix names (`p`, `bg`, `text`, …) and the
 * keyword utilities (`flex`, `items-center`, `w-full`, …) — stay declared
 * here because they're conventions, not tokens. The scale-driven slots get
 * populated dynamically.
 */

export type StyleFragment = Record<string, unknown>;

/**
 * Tailwind-style spacing prefixes. Cross-product with each `spacing` token to
 * produce the full `p-4`, `mx-2.5`, `gap-8` set. The prefix name doubles as
 * the Panda shorthand key — `{ p: '4' }`, `{ gap: '8' }` — so the resolver
 * picks up the spacing token type correctly.
 */
export const SPACING_PREFIX_NAMES = [
  "p",
  "px",
  "py",
  "pl",
  "pr",
  "pt",
  "pb",
  "m",
  "mx",
  "my",
  "ml",
  "mr",
  "mt",
  "mb",
  "gap",
] as const;

/**
 * Tailwind-style color prefixes. The Tailwind name may differ from the Panda
 * shorthand key (e.g. `text` → `color`); see COLOR_PREFIX_TO_PANDA_KEY below.
 */
export const COLOR_PREFIX_NAMES = ["bg", "text", "border"] as const;

const COLOR_PREFIX_TO_PANDA_KEY: Record<(typeof COLOR_PREFIX_NAMES)[number], string> = {
  bg: "bg",
  text: "color",
  border: "borderColor",
};

/**
 * Standalone utility names that don't fit a token-driven scale. Most are
 * direct CSS values (display, alignment); a few are convenience aliases.
 */
const KEYWORD_FRAGMENTS: Record<string, StyleFragment> = {
  flex: { display: "flex" },
  grid: { display: "grid" },
  block: { display: "block" },
  inline: { display: "inline" },
  "inline-block": { display: "inline-block" },
  hidden: { display: "none" },
  "items-start": { alignItems: "flex-start" },
  "items-center": { alignItems: "center" },
  "items-end": { alignItems: "flex-end" },
  "justify-start": { justifyContent: "flex-start" },
  "justify-center": { justifyContent: "center" },
  "justify-between": { justifyContent: "space-between" },
  "justify-end": { justifyContent: "flex-end" },
  "w-full": { width: "100%" },
  "h-full": { height: "100%" },
  "w-screen": { width: "100vw" },
  "h-screen": { height: "100vh" },
};

/**
 * Mutable shared map. Initialized with just the keyword utilities at module
 * load — call `populateUtilityMapFromTokens()` (typically from Panda's
 * `config:resolved` hook) to add the token-driven entries.
 *
 * Tests that exercise the transform directly without going through the hook
 * pipeline should call `populateUtilityMapFromTokens()` manually with a
 * mock token tree first.
 */
const UTILITY_MAP = new Map<string, StyleFragment>();

function seedKeywords(): void {
  for (const [name, fragment] of Object.entries(KEYWORD_FRAGMENTS)) {
    UTILITY_MAP.set(name, fragment);
  }
}

seedKeywords();

/**
 * Walk a Panda token tree (e.g. `tokens.spacing` or `tokens.colors`) and
 * collect every leaf token's dotted path. A leaf is any object with a
 * `value` field; intermediate nodes are walked recursively.
 *
 *   { 0: { value: '0' }, 4: { value: '1rem' } }       → ['0', '4']
 *   { blue: { 50: { value: '...' } }, black: { value: '#000' } }
 *                                                      → ['blue.50', 'black']
 */
function collectTokenPaths(node: unknown, prefix: string[] = []): string[] {
  if (node == null || typeof node !== "object") return [];
  // A token leaf: any object that has a `value` field. Panda tokens may carry
  // additional metadata (description, deprecated) on the same leaf object,
  // but `value` is the consistent marker.
  if ("value" in (node as Record<string, unknown>)) {
    return prefix.length === 0 ? [] : [prefix.join(".")];
  }
  const out: string[] = [];
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    out.push(...collectTokenPaths(child, [...prefix, key]));
  }
  return out;
}

/**
 * Shape of the slice of Panda's resolved tokens we read. Matches the
 * `Tokens` type from `@pandacss/types/tokens` structurally — we don't import
 * it because it would drag pkg-types into the bundle (see codegen-patch.ts
 * for the same reasoning around Artifact).
 */
export interface PandaTokens {
  spacing?: unknown;
  colors?: unknown;
  fontSizes?: unknown;
  fontWeights?: unknown;
  radii?: unknown;
  shadows?: unknown;
}

/**
 * Build the token-driven utility entries from a resolved Panda token tree.
 * Idempotent: clears the previous map (preserving the keyword seed) and
 * re-populates from scratch, so calling this multiple times during a
 * dev-server session keeps the map in sync with config changes.
 *
 * The shorthand-key conventions:
 *   - Spacing: `{prefix}-{tokenName}` → `{ [prefix]: tokenName }`
 *   - Colors:  `{prefix}-{family-shade}` → `{ [pandaKey]: 'family.shade' }`
 *              (root-level colors like `black` lose the dash split: `bg-black`)
 *   - Font sizes: `text-{size}` → `{ fontSize: size }` (3+ segments mean a
 *     color shorthand, so `text-lg` and `text-blue-500` disambiguate by
 *     segment count)
 *   - Font weights: `font-{weight}` → `{ fontWeight: weight }`
 *   - Radii: `rounded-{radius}` → `{ rounded: radius }` (plus bare `rounded`
 *     for the default)
 *   - Shadows: `shadow-{shadow}` → `{ shadow: shadow }` (plus bare `shadow`)
 */
export function populateUtilityMapFromTokens(tokens: PandaTokens | undefined): void {
  // Reset to just the keywords so multiple calls don't accumulate stale
  // entries from prior token sets.
  UTILITY_MAP.clear();
  seedKeywords();

  if (!tokens) return;

  // Spacing × prefix cross-product.
  const spacingPaths = collectTokenPaths(tokens.spacing);
  for (const prefix of SPACING_PREFIX_NAMES) {
    for (const value of spacingPaths) {
      UTILITY_MAP.set(`${prefix}-${value}`, { [prefix]: value });
    }
  }

  // Colors × prefix cross-product. Token paths use dot notation
  // (`blue.500`, `black`); convert to Tailwind dash notation for the utility
  // name while keeping the dotted form for Panda's value lookup.
  for (const tailwindPrefix of COLOR_PREFIX_NAMES) {
    const pandaKey = COLOR_PREFIX_TO_PANDA_KEY[tailwindPrefix];
    for (const tokenPath of collectTokenPaths(tokens.colors)) {
      const utilityName = `${tailwindPrefix}-${tokenPath.replace(/\./g, "-")}`;
      UTILITY_MAP.set(utilityName, { [pandaKey]: tokenPath });
    }
  }

  // Font sizes — `text-{size}`. Disambiguates from color `text-{family}-{shade}`
  // by segment count (font sizes are always single-segment token names).
  for (const size of collectTokenPaths(tokens.fontSizes)) {
    UTILITY_MAP.set(`text-${size}`, { fontSize: size });
  }

  // Font weights — `font-{name}`.
  for (const weight of collectTokenPaths(tokens.fontWeights)) {
    UTILITY_MAP.set(`font-${weight}`, { fontWeight: weight });
  }

  // Border radii — `rounded-{radius}`, plus a bare `rounded` alias mapped
  // to `md` (matches Tailwind's default).
  for (const radius of collectTokenPaths(tokens.radii)) {
    UTILITY_MAP.set(`rounded-${radius}`, { rounded: radius });
  }
  UTILITY_MAP.set("rounded", { rounded: "md" });

  // Box shadows — `shadow-{shadow}`, plus bare `shadow` aliased to `sm`.
  for (const shadow of collectTokenPaths(tokens.shadows)) {
    UTILITY_MAP.set(`shadow-${shadow}`, { shadow: shadow });
  }
  UTILITY_MAP.set("shadow", { shadow: "sm" });
}

/**
 * Resolve a single utility-string name to its style fragment.
 *
 * Returns `undefined` for unknown names so the transform can decide whether
 * to error or pass the call through unchanged. (MVP errors only on truly
 * unrecognized literal strings — runtime variables are always passed through.)
 */
export function resolveUtility(name: string): StyleFragment | undefined {
  return UTILITY_MAP.get(name);
}

/**
 * Snapshot of every recognized utility name. Consumed by `codegen-patch.ts`
 * to emit the `BearbonesUtilityName` type union into the patched `css.d.ts`.
 */
export function listUtilities(): readonly string[] {
  return Array.from(UTILITY_MAP.keys());
}

/**
 * Serialize the populated utility map to a JSON string. Used to share the
 * map across processes — Panda's extraction runs in `panda --watch` while
 * the runtime transform runs in `vp dev`. The Panda hook writes this string
 * to a cache file; the Vite plugin reads it and hydrates the map on startup.
 *
 * Without this hand-off, the Vite plugin's transform would see an empty map
 * (only the keyword seed), reject every token-driven utility string at
 * lower-time, and ship raw `'p-4'` strings to Panda's runtime — which would
 * then fail to produce matching atomic classNames.
 */
export function serializeUtilityMap(): string {
  return JSON.stringify(Array.from(UTILITY_MAP.entries()));
}

/**
 * Reset the map and re-populate from a JSON string previously produced by
 * `serializeUtilityMap`. Intended for cross-process map hand-off, not for
 * routine usage.
 */
export function hydrateUtilityMap(json: string): void {
  let entries: Array<[string, StyleFragment]>;
  try {
    entries = JSON.parse(json) as Array<[string, StyleFragment]>;
  } catch {
    // Malformed cache — fall through to a keyword-only seed. The transform
    // will pass token-driven utilities through unchanged; Panda's runtime
    // will surface the resulting empty classNames as a visible bug.
    return;
  }
  UTILITY_MAP.clear();
  for (const [k, v] of entries) {
    UTILITY_MAP.set(k, v);
  }
}
