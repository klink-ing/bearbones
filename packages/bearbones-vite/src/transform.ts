import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { parse } from "@babel/parser";
import MagicString from "magic-string";
import { resolveUtility, type StyleFragment } from "./utility-map.ts";
import {
  MARKER_RELATIONS,
  MARKER_STATES,
  STATE_PSEUDO,
  buildRelationConditionName,
  modifierHash,
  registerMarker,
  registerMarkerCondition,
  type MarkerRelation,
  type MarkerState,
  type RegisteredMarker,
} from "./marker-registry.ts";

/**
 * The lowering transform that runs in Panda's `parser:before` hook.
 *
 * Responsibilities:
 *   1. Find every `marker('id')` call at module scope and register it. We
 *      rewrite the call site to a synthesized callable-record so the runtime
 *      sees a typed value matching the `BearbonesMarker<Id>` interface — both
 *      the property shortcuts and the `(modifier).is.<relation>` chain.
 *   2. Find every `css(...)` call (only the local `css` binding from
 *      `bearbones`) and lower utility-string and condition-object arguments
 *      into Panda's native object form. Inside the object form, computed keys
 *      `[<binding>.<shortcut>]`, `[<binding>(LITERAL).is.<relation>]`, and
 *      `[<binding>._<state>.is.<relation>]` are lowered to literal Panda
 *      condition names so the extractor sees a static object.
 *   3. Emit a transformed source string. Panda's extractor then parses the
 *      transformed source as if it were authored that way.
 *
 * MVP scope choices:
 *   - Only literal-string and object-literal arguments are lowered. Variable
 *     references (e.g., `css(extra)`) pass through untouched and rely on
 *     Panda's existing runtime path.
 *   - `cva`/`sva` arguments accept the same input shapes; their `base` and
 *     each variant arm are recursively lowered.
 *   - `cx()` is left alone — it's a clsx-style runtime joiner per the spec.
 *
 * The transform is designed so that adding new utility names means appending
 * to the utility-map; the AST traversal does not need to change.
 */

interface ImportBindings {
  /**
   * Local binding names that resolve to the corresponding bearbones role.
   * Multiple entries allowed because a file can `import { css as _css }` and
   * then locally rebind via `const css = _css as ...` — both names should
   * trigger lowering at call sites.
   */
  css: Set<string>;
  cva: Set<string>;
  sva: Set<string>;
  marker: Set<string>;
}

function emptyBindings(): ImportBindings {
  return {
    css: new Set(),
    cva: new Set(),
    sva: new Set(),
    marker: new Set(),
  };
}

/**
 * Determine if an import source resolves to a bearbones-relevant binding.
 *
 * MVP recognizes:
 *   - `'bearbones'` itself — exposes marker, cx, and (future) css/cva/sva
 *     re-exports.
 *   - Panda's styled-system codegen output — `'../styled-system/css'`,
 *     `'./styled-system/recipes'`, etc. The path varies per project layout
 *     so we accept any path ending in `styled-system/css|recipes|jsx`.
 *
 * Future work: emit a virtual module from the bearbones facade so users can
 * always write `import { css } from 'bearbones'`, and the host paths become
 * an implementation detail.
 */
function isStyledSystemSource(source: string): "css" | "recipes" | null {
  if (source === "bearbones") return null; // handled separately
  if (/styled-system\/css(\.\w+)?$/.test(source)) return "css";
  if (/styled-system\/recipes(\.\w+)?$/.test(source)) return "recipes";
  return null;
}

/**
 * Walk top-level `const x = y` (or `const x = y as ...`) declarations. If `y`
 * is a tracked import binding (e.g., `_css`), bind `x` to the same role.
 *
 * This intentionally only follows simple aliases; chains of more than one
 * re-bind, function-wrapped versions, etc. are out of scope.
 */
function trackReBindings(ast: any, bindings: ImportBindings): void {
  for (const node of ast.program.body) {
    if (node.type !== "VariableDeclaration") continue;
    for (const declarator of node.declarations) {
      if (declarator.id.type !== "Identifier") continue;
      if (!declarator.init) continue;
      // Strip a `... as T` cast wrapper so we see through it.
      let init = declarator.init;
      while (init.type === "TSAsExpression" || init.type === "TSTypeAssertion") {
        init = init.expression;
      }
      // Allow chained casts: `_css as unknown as LooseCss` parses as
      // ((_css as unknown) as LooseCss). The loop above handles both.
      if (init.type !== "Identifier") continue;
      const sourceName = init.name;
      const localName = declarator.id.name;
      if (bindings.css.has(sourceName)) bindings.css.add(localName);
      if (bindings.cva.has(sourceName)) bindings.cva.add(localName);
      if (bindings.sva.has(sourceName)) bindings.sva.add(localName);
    }
  }
}

function findBearbonesImports(ast: any): ImportBindings {
  const bindings = emptyBindings();
  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration") continue;
    const source = node.source.value;
    const styledSystemKind = isStyledSystemSource(source);
    if (source !== "bearbones" && styledSystemKind === null) continue;
    for (const spec of node.specifiers) {
      if (spec.type !== "ImportSpecifier") continue;
      const imported = spec.imported.name;
      const local = spec.local.name;
      // Imports from styled-system/css expose only `css`. Imports from
      // styled-system/recipes expose `cva` and `sva`. Imports from
      // 'bearbones' expose marker + cx (and, when re-export wiring is done,
      // the others).
      if (imported === "css") bindings.css.add(local);
      else if (imported === "cva") bindings.cva.add(local);
      else if (imported === "sva") bindings.sva.add(local);
      else if (imported === "marker" && source === "bearbones") {
        bindings.marker.add(local);
      }
    }
  }
  return bindings;
}

/**
 * Lower a single AST argument of `css()` (and similar) into a Panda style
 * fragment. Returns `null` if the node isn't a shape we can statically resolve;
 * the caller then leaves it as-is.
 */
function lowerArgument(node: any, markers: MarkerCallContext): StyleFragment | null {
  if (node.type === "StringLiteral") {
    const fragment = resolveUtility(node.value);
    return fragment ?? null;
  }
  if (node.type === "ObjectExpression") {
    return lowerObject(node, markers);
  }
  if (node.type === "ArrayExpression") {
    // Used inside `cva` arms — array of utility strings or mixed.
    const merged: StyleFragment = {};
    for (const el of node.elements) {
      if (el == null) continue;
      const fragment = lowerArgument(el, markers);
      if (fragment) deepAssign(merged, fragment);
    }
    return merged;
  }
  return null;
}

/**
 * Lower an object literal into a Panda style fragment. Keys may be:
 *   - A static key name (`_hover`, `padding`) — passed through.
 *   - A computed `[marker.<state>]` key — rewritten to the registered Panda
 *     condition name like `_markerHover_card_a3f4b2`.
 *   - A computed `[marker(LITERAL).is.<relation>]` or `[marker._<state>.is.<relation>]`
 *     key — rewritten to the registered relational condition name.
 */
function lowerObject(node: any, markers: MarkerCallContext): StyleFragment | null {
  const out: StyleFragment = {};
  for (const prop of node.properties) {
    if (prop.type !== "ObjectProperty") return null;
    const key = resolveKey(prop, markers);
    if (key == null) return null;
    const value = lowerValue(prop.value, markers);
    if (value === undefined) return null;
    out[key] = value;
  }
  return out;
}

function resolveKey(prop: any, markers: MarkerCallContext): string | null {
  if (!prop.computed) {
    if (prop.key.type === "Identifier") return prop.key.name;
    if (prop.key.type === "StringLiteral") return prop.key.value;
    return null;
  }
  // Computed key: try the relational chain shapes first; fall back to the
  // simple `[marker.<state>]` shortcut shape.
  const relational = resolveRelationalKey(prop.key, markers);
  if (relational != null) return relational;
  if (
    prop.key.type === "MemberExpression" &&
    prop.key.object.type === "Identifier" &&
    prop.key.property.type === "Identifier" &&
    !prop.key.computed
  ) {
    const bindingName = prop.key.object.name;
    const state = prop.key.property.name;
    const marker = markers.byBinding(bindingName);
    if (!marker) return null;
    if (!isValidState(state)) return null;
    return `_marker${capitalize(state)}_${marker.suffix}`;
  }
  return null;
}

/**
 * Match `<binding>(LITERAL).is.<relation>` and `<binding>._<state>.is.<relation>`
 * computed keys. Returns the underscore-prefixed Panda condition name (i.e.,
 * what consumers write inside `[...]`), or `null` if the key isn't one of
 * the recognized relational chain shapes.
 *
 * Side effect: registers the (modifier, relation) pair against the marker so
 * `buildMarkerConditions()` emits a Panda condition at config:resolved time.
 * Idempotent — a second call with the same triple is a no-op.
 */
function resolveRelationalKey(node: any, markers: MarkerCallContext): string | null {
  if (node?.type !== "MemberExpression" || node.computed) return null;
  if (node.property.type !== "Identifier") return null;
  const relation = node.property.name as string;
  if (!isValidRelation(relation)) return null;

  const middle = node.object;
  if (middle?.type !== "MemberExpression" || middle.computed) return null;
  if (middle.property.type !== "Identifier" || middle.property.name !== "is") return null;

  const inner = middle.object;
  let bindingName: string | null = null;
  let modifier: string | null = null;

  if (inner?.type === "CallExpression") {
    if (inner.callee.type !== "Identifier") return null;
    bindingName = inner.callee.name;
    modifier = literalStringArg(inner.arguments[0]);
  } else if (inner?.type === "MemberExpression" && !inner.computed) {
    if (inner.object.type !== "Identifier") return null;
    bindingName = inner.object.name;
    if (inner.property.type !== "Identifier") return null;
    const propName = inner.property.name as string;
    if (!propName.startsWith("_")) return null;
    const stateName = propName.slice(1);
    if (!isValidState(stateName)) return null;
    modifier = STATE_PSEUDO[stateName];
  } else {
    return null;
  }

  if (bindingName == null || modifier == null) return null;
  const marker = markers.byBinding(bindingName);
  if (!marker) return null;

  const { conditionName } = registerMarkerCondition(
    marker.id,
    marker.modulePath,
    modifier,
    relation,
  );
  return `_${conditionName}`;
}

function isValidState(name: string): name is MarkerState {
  return (MARKER_STATES as readonly string[]).includes(name);
}

function isValidRelation(name: string): name is MarkerRelation {
  return (MARKER_RELATIONS as readonly string[]).includes(name);
}

function literalStringArg(arg: any): string | null {
  if (!arg) return null;
  if (arg.type === "StringLiteral") return arg.value;
  if (arg.type === "TemplateLiteral" && arg.expressions.length === 0) {
    return arg.quasis.map((q: any) => q.value.cooked).join("");
  }
  return null;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerValue(node: any, markers: MarkerCallContext): unknown {
  if (node.type === "StringLiteral") {
    // A bare utility string used as a value of a condition key, e.g.
    // `{ _hover: 'bg-blue-500' }` → resolves to a single fragment.
    const fragment = resolveUtility(node.value);
    if (fragment) return fragment;
    return node.value;
  }
  if (node.type === "NumericLiteral") return node.value;
  if (node.type === "BooleanLiteral") return node.value;
  if (node.type === "NullLiteral") return null;
  if (node.type === "ArrayExpression") {
    // Array of utility strings under a condition.
    const merged: StyleFragment = {};
    for (const el of node.elements) {
      if (el == null) continue;
      if (el.type === "StringLiteral") {
        const fragment = resolveUtility(el.value);
        if (fragment) Object.assign(merged, fragment);
      } else {
        const fragment = lowerArgument(el, markers);
        if (fragment) deepAssign(merged, fragment);
      }
    }
    return merged;
  }
  if (node.type === "ObjectExpression") {
    return lowerObject(node, markers);
  }
  return undefined;
}

/**
 * Deep-merge two style fragments. Later writes win at property leaves but
 * nested condition objects are merged recursively so ordering of fragments
 * matches Panda's own multi-arg `css()` semantics.
 */
function deepAssign(target: StyleFragment, source: StyleFragment): void {
  for (const [k, v] of Object.entries(source)) {
    const existing = target[k];
    if (
      existing != null &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      v != null &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      deepAssign(existing as StyleFragment, v as StyleFragment);
    } else {
      target[k] = v;
    }
  }
}

/**
 * Per-call binding context: which `marker(...)` declarations are visible at
 * each call site. Includes both local declarations and imports from other
 * files (which get pre-resolved by reading the imported source on demand).
 *
 * Pre-reading the imported file is necessary because Panda calls
 * `parser:before` once per file and doesn't guarantee processing order — a
 * consumer of `cardMarker` may be parsed before its declaring module.
 */
class MarkerCallContext {
  private readonly bindings = new Map<string, RegisteredMarker>();
  /** localName → absolute path of the imported file, for cross-file lookup. */
  private readonly imports = new Map<string, string>();

  bind(localName: string, marker: RegisteredMarker): void {
    this.bindings.set(localName, marker);
  }

  registerImport(localName: string, absolutePath: string): void {
    this.imports.set(localName, absolutePath);
  }

  byBinding(localName: string): RegisteredMarker | undefined {
    const cached = this.bindings.get(localName);
    if (cached) return cached;
    // Look up cross-file imports lazily.
    const sourcePath = this.imports.get(localName);
    if (!sourcePath) return undefined;
    const fromImport = resolveImportedMarker(sourcePath, localName);
    if (fromImport) {
      this.bindings.set(localName, fromImport);
      return fromImport;
    }
    return undefined;
  }
}

/**
 * Read an imported file, scan it for `marker()` declarations, and register the
 * matching binding name. Returns the registered marker (cached) or undefined.
 *
 * This is best-effort and intentionally loose: if the file can't be read, or
 * doesn't contain the expected declaration, we silently return undefined and
 * leave the call site untouched. The downstream Panda extractor will simply
 * skip the unrecognized condition key.
 */
function resolveImportedMarker(
  absolutePath: string,
  bindingName: string,
): RegisteredMarker | undefined {
  let content: string;
  try {
    content = readFileSync(absolutePath, "utf8");
  } catch {
    return undefined;
  }
  if (!content.includes("marker(")) return undefined;

  let ast: any;
  try {
    ast = parse(content, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    });
  } catch {
    return undefined;
  }

  const bindings = findBearbonesImports(ast);
  if (bindings.marker.size === 0) return undefined;

  for (const node of ast.program.body) {
    const decl =
      node.type === "ExportNamedDeclaration" && node.declaration ? node.declaration : node;
    if (decl.type !== "VariableDeclaration") continue;
    for (const declarator of decl.declarations) {
      if (declarator.id.type !== "Identifier") continue;
      if (declarator.id.name !== bindingName) continue;
      if (declarator.init?.type !== "CallExpression") continue;
      const callee = declarator.init.callee;
      if (callee.type !== "Identifier" || !bindings.marker.has(callee.name)) continue;
      const arg = declarator.init.arguments[0];
      if (!arg || arg.type !== "StringLiteral") continue;
      return registerMarker(arg.value, absolutePath);
    }
  }
  return undefined;
}

/**
 * Resolve an import specifier (`./markers.ts`, `../foo/bar`) to the absolute
 * path of the imported file, relative to the importing file.
 *
 * MVP: only supports relative imports. Bare specifiers (e.g.
 * `'@bearbones/preset'`) are ignored — they aren't where marker declarations
 * live in practice.
 */
function resolveRelativeImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = dirname(fromFile);
  const candidate = resolvePath(base, specifier);
  // Try the candidate as-is, plus common TS extensions, before giving up.
  const tries = [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}/index.ts`,
    `${candidate}/index.tsx`,
  ];
  for (const path of tries) {
    try {
      readFileSync(path, "utf8");
      return path;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Discover top-level `const x = marker('id')` declarations. Each becomes a
 * binding the call-site lowering can resolve when it sees `[x.hover]` keys.
 *
 * For each declaration, we also rewrite the right-hand side to a synthesized
 * callable record carrying the marker's anchor class, the registered shortcut
 * keys, and a tiny IIFE that handles `(modifier).is.<relation>` chains at
 * runtime. Inline FNV-1a keeps build-side and runtime modifier hashes aligned
 * without a shared bundle import.
 */
function processMarkerDeclarations(
  ast: any,
  bindings: ImportBindings,
  modulePath: string,
  source: MagicString,
): { ctx: MarkerCallContext; needsRelationsHelper: boolean } {
  const ctx = new MarkerCallContext();
  let needsRelationsHelper = false;

  // Track every relative import so when we see a `[binding.state]` computed
  // key in this file, we know which source file to consult for the
  // declaration.
  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration") continue;
    const spec = node.source.value;
    const resolved = resolveRelativeImport(modulePath, spec);
    if (!resolved) continue;
    for (const importSpec of node.specifiers) {
      if (importSpec.type !== "ImportSpecifier") continue;
      ctx.registerImport(importSpec.local.name, resolved);
    }
  }

  if (bindings.marker.size === 0) return { ctx, needsRelationsHelper };
  for (const node of ast.program.body) {
    const decl =
      node.type === "ExportNamedDeclaration" && node.declaration ? node.declaration : node;
    if (decl.type !== "VariableDeclaration") continue;
    for (const declarator of decl.declarations) {
      if (declarator.id.type !== "Identifier") continue;
      if (declarator.init?.type !== "CallExpression") continue;
      const callee = declarator.init.callee;
      if (callee.type !== "Identifier" || !bindings.marker.has(callee.name)) continue;
      const arg = declarator.init.arguments[0];
      if (!arg || arg.type !== "StringLiteral") {
        throw new Error(`bearbones: marker() requires a literal string id at ${modulePath}`);
      }
      const id = arg.value;
      const registered = registerMarker(id, modulePath);
      ctx.bind(declarator.id.name, registered);

      // Rewrite the call to a synthesized record literal so the runtime
      // doesn't need a real `marker()` implementation.
      const replacement = renderMarkerRecord(registered);
      source.overwrite(declarator.init.start, declarator.init.end, replacement);
      needsRelationsHelper = true;
    }
  }
  return { ctx, needsRelationsHelper };
}

/**
 * Inline runtime helper. Builds an `{ is: { ancestor, descendant, sibling } }`
 * object for a given `(modifier, suffix)` pair. The FNV-1a 32-bit hash MUST
 * match `modifierHash` in `marker-registry.ts` byte-for-byte: build-side
 * registers conditions named after the build-side hash, and the runtime
 * computes the same key from the same selector at call sites the transform
 * can't statically lower (variable bindings, dynamic selectors).
 *
 * Emitted once per file that declares any marker. The synthesized marker
 * record closes over this constant via a normal lexical reference.
 */
const RELATIONS_HELPER_NAME = "__bearbones_relations";
const RELATIONS_HELPER_SOURCE = `const ${RELATIONS_HELPER_NAME} = (m, s) => {
  let _h = 0x811c9dc5 | 0;
  for (let i = 0; i < m.length; i++) _h = Math.imul(_h ^ m.charCodeAt(i), 0x01000193) | 0;
  const x = (_h >>> 0).toString(16).padStart(8, "0");
  return { is: { ancestor: \`_marker_\${s}_ancestor_\${x}\`, descendant: \`_marker_\${s}_descendant_\${x}\`, sibling: \`_marker_\${s}_sibling_\${x}\` } };
};`;

function renderMarkerRecord(marker: RegisteredMarker): string {
  const fields: string[] = [
    `anchor: ${JSON.stringify(marker.anchorClass)}`,
    ...MARKER_STATES.map((state) => `${state}: "_marker${capitalize(state)}_${marker.suffix}"`),
    // Build the underscore builder forms eagerly with literal strings. The
    // inlined hash function below rebuilds the same literals at runtime via
    // the call form, so both paths agree.
    ...MARKER_STATES.map((state) => {
      const modifier = STATE_PSEUDO[state];
      const h = modifierHash(modifier);
      const ancestor = buildRelationConditionName(marker.suffix, "ancestor", modifier);
      const descendant = buildRelationConditionName(marker.suffix, "descendant", modifier);
      const sibling = buildRelationConditionName(marker.suffix, "sibling", modifier);
      // `h` is captured for symmetry with the runtime's computed naming and
      // to make the snapshot self-documenting; the values below are derived
      // from it deterministically.
      void h;
      return `_${state}: { is: { ancestor: "_${ancestor}", descendant: "_${descendant}", sibling: "_${sibling}" } }`;
    }),
  ];
  // Object.assign(fn, { ...shortcuts }) — the function half handles the
  // `(modifier).is.<relation>` call form, the assigned properties cover the
  // existing shortcuts and the `_<state>.is.<relation>` underscore form.
  return `Object.assign((m) => ${RELATIONS_HELPER_NAME}(m, ${JSON.stringify(marker.suffix)}), { ${fields.join(", ")} })`;
}

/**
 * Walk the AST looking for calls to css/cva/sva and lower their arguments
 * in-place via the magic-string source map.
 */
function processCalls(
  ast: any,
  bindings: ImportBindings,
  source: MagicString,
  markers: MarkerCallContext,
): void {
  walk(ast, (node: any) => {
    if (node?.type !== "CallExpression") return;
    const callee = node.callee;
    if (callee.type !== "Identifier") return;
    const name = callee.name;
    if (bindings.css.has(name) || bindings.cva.has(name) || bindings.sva.has(name)) {
      lowerCallArguments(node, source, markers);
    }
  });
}

function lowerCallArguments(call: any, source: MagicString, markers: MarkerCallContext): void {
  for (const arg of call.arguments) {
    const fragment = lowerArgument(arg, markers);
    if (fragment == null) continue;
    source.overwrite(arg.start, arg.end, renderObject(fragment));
  }
}

function renderObject(fragment: StyleFragment): string {
  return JSON.stringify(fragment);
}

/**
 * Tiny depth-first walker. Avoids pulling in @babel/traverse, which is heavy
 * and has its own deps. We only need to visit every node once.
 */
function walk(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range") continue;
    walk(node[key], visit);
  }
}

export interface TransformInput {
  filePath: string;
  source: string;
}

export interface TransformResult {
  /** New source content, or `undefined` if no change is needed. */
  content: string | undefined;
}

export function transform(input: TransformInput): TransformResult {
  // Cheap early-exit: if the file references neither our package nor the
  // styled-system entry points, there's nothing for us to do. Saves a Babel
  // parse on most files in a typical project.
  if (!input.source.includes("bearbones") && !input.source.includes("styled-system")) {
    return { content: undefined };
  }

  let ast: any;
  try {
    ast = parse(input.source, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
      sourceFilename: input.filePath,
      ranges: true,
    });
  } catch {
    // Files we can't parse (e.g. weird syntax) are passed through.
    return { content: undefined };
  }

  const bindings = findBearbonesImports(ast);
  if (
    bindings.css.size === 0 &&
    bindings.cva.size === 0 &&
    bindings.sva.size === 0 &&
    bindings.marker.size === 0
  ) {
    return { content: undefined };
  }

  // Follow simple top-level re-bindings: `const css = _css as ...`.
  trackReBindings(ast, bindings);

  const ms = new MagicString(input.source);
  const { ctx: markers, needsRelationsHelper } = processMarkerDeclarations(
    ast,
    bindings,
    input.filePath,
    ms,
  );
  processCalls(ast, bindings, ms, markers);

  if (needsRelationsHelper) {
    // Prepend the helper. The transform's argument-lowering pass produces
    // static condition strings inside `css({})` calls, but variable bindings
    // of `<binding>(sel).is.<rel>` (and runtime evaluation in general) need
    // the helper to compute matching condition names.
    ms.prepend(`${RELATIONS_HELPER_SOURCE}\n`);
  }

  const result = ms.toString();
  return { content: result === input.source ? undefined : result };
}
