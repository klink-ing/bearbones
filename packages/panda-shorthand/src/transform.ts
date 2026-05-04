/**
 * Lowering transform for the shorthand plugin. Runs in Panda's
 * `parser:before` hook and again in the Vite plugin's `transform` hook
 * (same code path, run twice across two processes).
 *
 * Responsibilities — narrow on purpose:
 *   1. Find every `css(...)` / `cva(...)` / `sva(...)` call (only local
 *      bindings imported from `styled-system/css` or `styled-system/recipes`).
 *   2. For each top-level argument that's a literal utility string, an
 *      array of strings, or an object literal containing such strings as
 *      values, emit the lowered Panda style fragment in place via
 *      magic-string. Anything we can't statically resolve passes through
 *      untouched.
 *
 * Marker rewriting and relational-key resolution live in
 * `@klinking/panda-markers` — that plugin runs its own `parser:before` hook
 * before this one when both are installed. The two transforms commute on
 * disjoint AST node types: markers replaces *computed property keys* and
 * the marker() declaration RHS, shorthand replaces *string-literal arg
 * values*. Order between the two doesn't change the final source.
 *
 * MVP scope choices:
 *   - Only literal-string and object-literal arguments are lowered.
 *     Variable references (`css(extra)`) pass through to Panda's runtime.
 *   - `cva`/`sva` arguments accept the same input shapes; their `base`
 *     and each variant arm are recursively lowered.
 *   - `cx()` is left alone — it's a clsx-style runtime joiner per the spec.
 */

import MagicString from "magic-string";
import {
  deepAssign,
  findStyledSystemImports,
  parseSource,
  trackReBindings,
  walk,
  type ImportBindings,
} from "@klinking/panda-utils";
import { resolveUtility, type StyleFragment } from "./utility-map.ts";

function lowerArgument(node: any): StyleFragment | null {
  if (node.type === "StringLiteral") {
    const fragment = resolveUtility(node.value);
    return fragment ?? null;
  }
  if (node.type === "ObjectExpression") {
    return lowerObject(node);
  }
  if (node.type === "ArrayExpression") {
    const merged: StyleFragment = {};
    for (const el of node.elements) {
      if (el == null) continue;
      const fragment = lowerArgument(el);
      if (fragment) deepAssign(merged, fragment);
    }
    return merged;
  }
  return null;
}

/**
 * Lower an object literal into a Panda style fragment. Keys are passed
 * through verbatim — including string-literal keys that the markers plugin
 * may have emitted at this position from a relational chain. Computed keys
 * this plugin doesn't recognize bail out and leave the whole object
 * untouched.
 */
function lowerObject(node: any): StyleFragment | null {
  const out: StyleFragment = {};
  for (const prop of node.properties) {
    if (prop.type !== "ObjectProperty") return null;
    const key = resolveKey(prop);
    if (key == null) return null;
    const value = lowerValue(prop.value);
    if (value === undefined) return null;
    out[key] = value;
  }
  return out;
}

function resolveKey(prop: any): string | null {
  if (prop.computed) return null;
  if (prop.key.type === "Identifier") return prop.key.name;
  if (prop.key.type === "StringLiteral") return prop.key.value;
  return null;
}

function lowerValue(node: any): unknown {
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
        const fragment = lowerArgument(el);
        if (fragment) deepAssign(merged, fragment);
      }
    }
    return merged;
  }
  if (node.type === "ObjectExpression") {
    return lowerObject(node);
  }
  return undefined;
}

function processCalls(ast: any, bindings: ImportBindings, source: MagicString): void {
  walk(ast, (node: any) => {
    if (node?.type !== "CallExpression") return;
    const callee = node.callee;
    if (callee.type !== "Identifier") return;
    const name = callee.name;
    if (bindings.css.has(name) || bindings.cva.has(name) || bindings.sva.has(name)) {
      lowerCallArguments(node, source);
    }
  });
}

function lowerCallArguments(call: any, source: MagicString): void {
  for (const arg of call.arguments) {
    const fragment = lowerArgument(arg);
    if (fragment == null) continue;
    source.overwrite(arg.start, arg.end, JSON.stringify(fragment));
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
  // Cheap early-exit: if the file doesn't reference styled-system at all,
  // we have nothing to lower. Saves a Babel parse on most files.
  if (!input.source.includes("styled-system")) {
    return { content: undefined };
  }

  const ast = parseSource(input.source, input.filePath);
  if (ast === null) return { content: undefined };

  const bindings = findStyledSystemImports(ast);
  if (bindings.css.size === 0 && bindings.cva.size === 0 && bindings.sva.size === 0) {
    return { content: undefined };
  }

  trackReBindings(ast, bindings);

  const ms = new MagicString(input.source);
  processCalls(ast, bindings, ms);

  const result = ms.toString();
  return { content: result === input.source ? undefined : result };
}
