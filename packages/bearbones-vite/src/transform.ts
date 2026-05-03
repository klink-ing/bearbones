import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { parse } from "@babel/parser";
import MagicString from "magic-string";
import { resolveUtility, type StyleFragment } from "./utility-map.ts";
import { getCondition, listConditionsWithAnchor } from "./conditions-stash.ts";
import {
  MARKER_RELATIONS,
  RELATION_SELECTORS,
  buildRelationSelector,
  describeMarker,
  type MarkerDescriptor,
  type MarkerRelation,
} from "./marker-registry.ts";

/**
 * The lowering transform that runs in Panda's `parser:before` hook.
 *
 * Responsibilities:
 *   1. Find every `marker('id')` call at module scope and register it. We
 *      rewrite the call site to a synthesized callable record so the runtime
 *      sees a typed value matching the `BearbonesMarker<Id>` interface — both
 *      the property shortcuts and the `(condValue).is.<relation>` chain.
 *   2. Find every `css(...)` / `cva(...)` / `sva(...)` call (only local
 *      bindings imported from `styled-system/css` or `styled-system/recipes`)
 *      and lower utility-string and condition-object arguments into Panda's
 *      native object form. Inside the object form, computed keys
 *      `[<binding>(LITERAL).is.<relation>]` and `[<binding>._<name>.is.<relation>]`
 *      are lowered to literal Panda raw selectors so the extractor sees a
 *      static object.
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
 * Both `css` and `marker` come from `styled-system/css`; `cva`/`sva` come
 * from `styled-system/recipes`. The path varies per project layout so we
 * accept any path ending in `styled-system/css|recipes|jsx`.
 */
function isStyledSystemSource(source: string): "css" | "recipes" | null {
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
      let init = declarator.init;
      while (init.type === "TSAsExpression" || init.type === "TSTypeAssertion") {
        init = init.expression;
      }
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
    if (styledSystemKind === null) continue;
    for (const spec of node.specifiers) {
      if (spec.type !== "ImportSpecifier") continue;
      const imported = spec.imported.name;
      const local = spec.local.name;
      if (styledSystemKind === "css") {
        if (imported === "css") bindings.css.add(local);
        else if (imported === "marker") bindings.marker.add(local);
      } else if (styledSystemKind === "recipes") {
        if (imported === "cva") bindings.cva.add(local);
        else if (imported === "sva") bindings.sva.add(local);
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
 *   - A computed `[marker(LITERAL).is.<relation>]` or `[marker._<name>.is.<relation>]`
 *     key — rewritten to the registered relational raw selector.
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
  return resolveRelationalKey(prop.key, markers);
}

/**
 * Match `<binding>(LITERAL).is.<relation>` and `<binding>._<name>.is.<relation>`
 * computed keys. Returns the *raw selector string* Panda will treat as a
 * parent-/self-/combinator-nesting selector, or `null` if the key isn't one
 * of the recognized relational chain shapes.
 *
 * No side effects. The composed selector is the identity of the rule —
 * Panda's parser handles the rest at extraction time without any condition
 * needing to be pre-registered.
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
  let condValue: string | null = null;

  if (inner?.type === "CallExpression") {
    if (inner.callee.type !== "Identifier") return null;
    bindingName = inner.callee.name;
    condValue = literalStringArg(inner.arguments[0]);
  } else if (inner?.type === "MemberExpression" && !inner.computed) {
    if (inner.object.type !== "Identifier") return null;
    bindingName = inner.object.name;
    if (inner.property.type !== "Identifier") return null;
    const propName = inner.property.name as string;
    if (!propName.startsWith("_")) return null;
    const condName = propName.slice(1);
    const looked = getCondition(condName);
    if (looked === undefined) {
      throw new Error(
        `bearbones: marker._${condName} references an unregistered condition. ` +
          `Either declare it under \`conditions\` in panda.config.ts or use the ` +
          `call form \`marker('<value>')\` directly.`,
      );
    }
    condValue = looked;
  } else {
    return null;
  }

  if (bindingName == null || condValue == null) return null;
  const marker = markers.byBinding(bindingName);
  if (!marker) return null;

  return buildRelationSelector(marker.anchorClass, condValue, relation);
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

function lowerValue(node: any, markers: MarkerCallContext): unknown {
  if (node.type === "StringLiteral") {
    const fragment = resolveUtility(node.value);
    if (fragment) return fragment;
    return node.value;
  }
  if (node.type === "NumericLiteral") return node.value;
  if (node.type === "BooleanLiteral") return node.value;
  if (node.type === "NullLiteral") return null;
  if (node.type === "ArrayExpression") {
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
 */
class MarkerCallContext {
  private readonly bindings = new Map<string, MarkerDescriptor>();
  /** localName → absolute path of the imported file, for cross-file lookup. */
  private readonly imports = new Map<string, string>();

  bind(localName: string, marker: MarkerDescriptor): void {
    this.bindings.set(localName, marker);
  }

  registerImport(localName: string, absolutePath: string): void {
    this.imports.set(localName, absolutePath);
  }

  byBinding(localName: string): MarkerDescriptor | undefined {
    const cached = this.bindings.get(localName);
    if (cached) return cached;
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
 * Read an imported file, scan it for the `marker()` declaration matching
 * `bindingName`, and return a `MarkerDescriptor` derived from `(id, path)`.
 *
 * Best-effort and intentionally loose: if the file can't be read, or doesn't
 * contain the expected declaration, we silently return undefined.
 */
function resolveImportedMarker(
  absolutePath: string,
  bindingName: string,
): MarkerDescriptor | undefined {
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
      return describeMarker(arg.value, absolutePath);
    }
  }
  return undefined;
}

/**
 * Resolve an import specifier (`./markers.ts`, `../foo/bar`) to the absolute
 * path of the imported file, relative to the importing file.
 */
function resolveRelativeImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = dirname(fromFile);
  const candidate = resolvePath(base, specifier);
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
 * binding the call-site lowering can resolve when it sees `[x._<name>.is.<rel>]`
 * or `[x(LITERAL).is.<rel>]` computed keys.
 *
 * For each declaration, we also rewrite the right-hand side to a synthesized
 * callable record carrying the marker's anchor class, the typed `_<name>`
 * builders (one per registered condition), and a tiny IIFE that handles
 * `(condValue).is.<relation>` chains at runtime.
 */
function processMarkerDeclarations(
  ast: any,
  bindings: ImportBindings,
  modulePath: string,
  source: MagicString,
): { ctx: MarkerCallContext; needsRelationsHelper: boolean } {
  const ctx = new MarkerCallContext();
  let needsRelationsHelper = false;

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
      const descriptor = describeMarker(id, modulePath);
      ctx.bind(declarator.id.name, descriptor);

      const replacement = renderMarkerRecord(descriptor);
      source.overwrite(declarator.init.start, declarator.init.end, replacement);
      needsRelationsHelper = true;
    }
  }
  return { ctx, needsRelationsHelper };
}

/**
 * Inline runtime helper. Composes the five raw-selector strings for a
 * `(condValue, anchorClass)` pair so variable-bound chains (e.g.
 * `const k = m('&:hover').is.ancestor`) work at runtime. Substitutes every
 * `&` in the input with the marker's anchor selector, then runs the
 * `RELATION_SELECTORS` templates against the result.
 *
 * The body is *derived* from `RELATION_SELECTORS` at build time (see
 * `buildRelationsHelperBody`), so the runtime path stays byte-identical to
 * `buildRelationSelector` in `marker-registry.ts` — no second copy of the
 * selector shapes maintained by hand.
 *
 * Emitted once per file that declares any marker. The synthesized marker
 * record closes over this constant via a normal lexical reference.
 */
const RELATIONS_HELPER_NAME = "__bearbones_relations";

function buildRelationsHelperBody(): string {
  const entries = Object.entries(RELATION_SELECTORS).map(([relation, parts]) => {
    const expr = parts.map((p) => JSON.stringify(p)).join(" + m + ");
    return `${relation}: ${expr}`;
  });
  return `{ is: { ${entries.join(", ")} } }`;
}

const RELATIONS_HELPER_SOURCE = `const ${RELATIONS_HELPER_NAME} = (c, a) => {
  const m = c.split("&").join("." + a);
  return ${buildRelationsHelperBody()};
};`;

function renderMarkerRecord(marker: MarkerDescriptor): string {
  const fields: string[] = [`anchor: ${JSON.stringify(marker.anchorClass)}`];
  // Bake in `_<name>` shortcut for every condition whose value contains `&`.
  // The stash is pre-populated from preset-base at module load and replaced
  // with the host project's resolved conditions during `config:resolved` —
  // by the time `parser:before` runs (where this transform fires), the stash
  // reflects the user's full vocabulary including any extensions.
  for (const { name, value } of listConditionsWithAnchor()) {
    const isEntries = MARKER_RELATIONS.map((relation) => {
      const sel = buildRelationSelector(marker.anchorClass, value, relation);
      return `${relation}: ${JSON.stringify(sel)}`;
    });
    fields.push(`_${name}: { is: { ${isEntries.join(", ")} } }`);
  }
  return `Object.assign((c) => ${RELATIONS_HELPER_NAME}(c, ${JSON.stringify(marker.anchorClass)}), { ${fields.join(", ")} })`;
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
  // Cheap early-exit: if the file references styled-system not at all, we
  // have nothing to lower. Saves a Babel parse on most files.
  if (!input.source.includes("styled-system")) {
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
    ms.prepend(`${RELATIONS_HELPER_SOURCE}\n`);
  }

  const result = ms.toString();
  return { content: result === input.source ? undefined : result };
}
