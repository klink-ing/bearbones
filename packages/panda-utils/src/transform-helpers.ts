/**
 * Shared transform helpers consumed by the per-plugin lowering passes in
 * @klinking/panda-markers and @klinking/panda-shorthand. Both plugins'
 * `parser:before` hooks need to discover the styled-system bindings in
 * scope (`css`, `cva`, `sva`, `marker`) before they can decide whether
 * any call site needs lowering.
 *
 * No plugin-specific logic lives here — that's per-plugin in each
 * package's own `transform.ts`.
 */

import { parse } from "@babel/parser";

export interface ImportBindings {
  /** Local binding names that resolve to `css` from `styled-system/css`. */
  css: Set<string>;
  /** Local binding names that resolve to `cva` from `styled-system/recipes`. */
  cva: Set<string>;
  /** Local binding names that resolve to `sva` from `styled-system/recipes`. */
  sva: Set<string>;
  /** Local binding names that resolve to `marker` from `styled-system/css`. */
  marker: Set<string>;
}

export function emptyBindings(): ImportBindings {
  return {
    css: new Set(),
    cva: new Set(),
    sva: new Set(),
    marker: new Set(),
  };
}

/**
 * Determine if an import source resolves to a styled-system module.
 *
 * Both `css` and `marker` come from `styled-system/css`; `cva`/`sva` come
 * from `styled-system/recipes`. The path varies per project layout so we
 * accept any path ending in `styled-system/css|recipes`.
 */
export function isStyledSystemSource(source: string): "css" | "recipes" | null {
  if (/styled-system\/css(\.\w+)?$/.test(source)) return "css";
  if (/styled-system\/recipes(\.\w+)?$/.test(source)) return "recipes";
  return null;
}

/**
 * Walk the program body and collect every `css`/`cva`/`sva`/`marker` import
 * binding. Plugins typically follow this with a `trackReBindings` pass to
 * pick up `const x = css as ...` aliases as well.
 */
export function findStyledSystemImports(ast: any): ImportBindings {
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
 * Walk top-level `const x = y` (or `const x = y as ...`) declarations. If
 * `y` is a tracked import binding (e.g., `_css`), bind `x` to the same role.
 *
 * This intentionally only follows simple aliases; chains of more than one
 * re-bind, function-wrapped versions, etc. are out of scope.
 */
export function trackReBindings(ast: any, bindings: ImportBindings): void {
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

/**
 * Extract a literal-string value from a Babel AST argument node. Returns
 * `null` if the node isn't a static string. Recognizes both plain
 * `StringLiteral` and zero-expression `TemplateLiteral`.
 */
export function literalStringArg(arg: any): string | null {
  if (!arg) return null;
  if (arg.type === "StringLiteral") return arg.value;
  if (arg.type === "TemplateLiteral" && arg.expressions.length === 0) {
    return arg.quasis.map((q: any) => q.value.cooked).join("");
  }
  return null;
}

/**
 * Parse a TypeScript / JSX source file with Babel. Returns `null` on parse
 * error so callers can short-circuit to "no transform" rather than throwing
 * — matches the conservative behavior plugins want for files they can't
 * understand.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Babel AST nodes
export function parseSource(source: string, filePath?: string): any {
  try {
    return parse(source, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
      sourceFilename: filePath,
      ranges: true,
    });
  } catch {
    return null;
  }
}

/**
 * Generic AST walk. Visits every node with a `.type` field; skips loc/range
 * subtrees so the walk is O(nodes), not O(nodes * loc-fields).
 */
export function walk(node: any, visit: (n: any) => void): void {
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
