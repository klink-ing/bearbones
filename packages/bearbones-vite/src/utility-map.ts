/**
 * Utility-string vocabulary for the bearbones MVP.
 *
 * Each entry maps a Tailwind v4-flavored utility name to the Panda style-object
 * fragment that produces the same atomic class. The transform uses this table
 * during `parser:before` to lower `css('p-4')` into `css({ p: 4 })`.
 *
 * Scope is intentionally narrow for MVP — only the utilities exercised by the
 * demo and snapshot tests are implemented. The pattern is designed so that
 * adding a new utility means appending to one of the generators below; the
 * transform does not change.
 *
 * Future work:
 * - Generate this table from `@bearbones/preset` so the preset is the single
 *   source of truth for utility names + token references. Today the type
 *   union and the runtime map are both derived from the scale arrays below;
 *   driving them off the resolved Panda preset would let host projects
 *   extend or narrow the vocabulary without touching this file.
 */

export type StyleFragment = Record<string, unknown>;

// All scale arrays are exported `as const` so a matching template-literal
// type union can be derived for `BearbonesUtilityName` without duplicating
// the source of truth.
export const SPACING_SCALE = [
  "0",
  "0.5",
  "1",
  "1.5",
  "2",
  "2.5",
  "3",
  "4",
  "5",
  "6",
  "8",
  "10",
  "12",
  "16",
  "20",
  "24",
] as const;

export const COLOR_FAMILIES = [
  "slate",
  "gray",
  "zinc",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "indigo",
  "purple",
  "pink",
] as const;

export const COLOR_SHADES = [
  "50",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
] as const;

export const FONT_SIZE_SCALE = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl"] as const;

export const FONT_WEIGHT_NAMES = ["thin", "light", "normal", "medium", "bold"] as const;

export const RADIUS_SCALE = ["none", "sm", "md", "lg", "xl", "2xl", "full"] as const;

export const SHADOW_SCALE = ["sm", "md", "lg", "xl", "2xl", "none"] as const;

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

export const COLOR_PREFIX_NAMES = ["bg", "text", "border"] as const;

export const KEYWORD_UTILITIES = [
  "flex",
  "grid",
  "block",
  "inline",
  "inline-block",
  "hidden",
  "items-start",
  "items-center",
  "items-end",
  "justify-start",
  "justify-center",
  "justify-between",
  "justify-end",
  "rounded",
  "shadow",
  "w-full",
  "h-full",
  "w-screen",
  "h-screen",
] as const;

type SpacingPrefix = (typeof SPACING_PREFIX_NAMES)[number];
type SpacingValue = (typeof SPACING_SCALE)[number];
type ColorPrefix = (typeof COLOR_PREFIX_NAMES)[number];
type ColorFamily = (typeof COLOR_FAMILIES)[number];
type ColorShade = (typeof COLOR_SHADES)[number];
type FontSize = (typeof FONT_SIZE_SCALE)[number];
type FontWeight = (typeof FONT_WEIGHT_NAMES)[number];
type Radius = (typeof RADIUS_SCALE)[number];
type Shadow = (typeof SHADOW_SCALE)[number];

/**
 * The closed union of every utility-string name accepted by `css()`.
 *
 * Derived from the same constants the runtime utility map is built from, so
 * the type is guaranteed to be in sync with what the transform actually
 * recognizes. Adding a value to a scale or prefix array narrows/widens both
 * the runtime and the type at the same time.
 */
export type BearbonesUtilityName =
  | (typeof KEYWORD_UTILITIES)[number]
  | `${SpacingPrefix}-${SpacingValue}`
  | `${ColorPrefix}-${ColorFamily}-${ColorShade}`
  | `${ColorPrefix}-${"white" | "black" | "transparent"}`
  | `text-${FontSize}`
  | `font-${FontWeight}`
  | `rounded-${Radius}`
  | `shadow-${Shadow}`;

/**
 * Build the static utility lookup table once at module load.
 *
 * The table is intentionally a `Map` so future work can lazily extend it
 * without rebuilding the bundle.
 */
function buildUtilityMap(): Map<string, StyleFragment> {
  const map = new Map<string, StyleFragment>();

  // Standalone keywords.
  const KEYWORDS: Record<string, StyleFragment> = {
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
  };
  for (const [name, value] of Object.entries(KEYWORDS)) map.set(name, value);

  // Spacing-scale utilities. Use Panda's shorthand keys so the resolver
  // looks up the spacing token type. Writing `{ padding: '4' }` would
  // emit a literal CSS value; `{ p: 4 }` resolves to `var(--spacing-4)`.
  for (const prefix of SPACING_PREFIX_NAMES) {
    for (const value of SPACING_SCALE) {
      // Panda accepts string values for token references. Numeric strings
      // hit the spacing scale lookup; arbitrary strings pass through.
      map.set(`${prefix}-${value}`, { [prefix]: value });
    }
  }

  // Color-scale utilities. Same shorthand-key reasoning: `bg`/`color`/
  // `borderColor` all opt into the colors token type via Panda's defaults.
  // The Tailwind prefix may differ from the Panda key (e.g. `text` → `color`).
  const COLOR_PREFIX_TO_PANDA_KEY: Record<(typeof COLOR_PREFIX_NAMES)[number], string> = {
    bg: "bg",
    text: "color",
    border: "borderColor",
  };
  for (const tailwindPrefix of COLOR_PREFIX_NAMES) {
    const pandaKey = COLOR_PREFIX_TO_PANDA_KEY[tailwindPrefix];
    for (const family of COLOR_FAMILIES) {
      for (const shade of COLOR_SHADES) {
        // Tailwind dashes → Panda dot reference: `bg-blue-500` → `blue.500`.
        map.set(`${tailwindPrefix}-${family}-${shade}`, {
          [pandaKey]: `${family}.${shade}`,
        });
      }
    }
    map.set(`${tailwindPrefix}-white`, { [pandaKey]: "white" });
    map.set(`${tailwindPrefix}-black`, { [pandaKey]: "black" });
    map.set(`${tailwindPrefix}-transparent`, { [pandaKey]: "transparent" });
  }

  // Font sizes — `text-lg` collides with the color prefix above; the color
  // version is `text-<color>-<shade>`, which has three segments. The font-size
  // form has only two and a known scale name, so it disambiguates correctly.
  for (const size of FONT_SIZE_SCALE) {
    // `fontSize` is a recognized Panda key and resolves the `fontSizes`
    // token scale.
    map.set(`text-${size}`, { fontSize: size });
  }

  // Font weights — use the Panda shorthand `fontWeight` which resolves the
  // `fontWeights` token type. The scale uses dot-notation names like
  // `font.weights.bold`, but we map directly to the named token.
  for (const name of FONT_WEIGHT_NAMES) {
    map.set(`font-${name}`, { fontWeight: name });
  }

  // Border radii. `rounded` is a Panda shorthand that resolves the `radii`
  // token type.
  for (const value of RADIUS_SCALE) {
    map.set(`rounded-${value}`, { rounded: value });
  }
  map.set("rounded", { rounded: "md" });

  // Box shadows. `shadow` shorthand resolves the `shadows` token type.
  for (const value of SHADOW_SCALE) {
    map.set(`shadow-${value}`, { shadow: value });
  }
  map.set("shadow", { shadow: "sm" });

  // Width / height keywords.
  map.set("w-full", { width: "100%" });
  map.set("h-full", { height: "100%" });
  map.set("w-screen", { width: "100vw" });
  map.set("h-screen", { height: "100vh" });

  return map;
}

const UTILITY_MAP = buildUtilityMap();

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
