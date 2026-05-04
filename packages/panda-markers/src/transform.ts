/**
 * Lowering transform for the markers plugin.
 *
 * Two responsibilities — narrow on purpose:
 *   1. Rewrite top-level `const x = marker('id')` declarations to a
 *      synthesized callable record matching the `BearbonesMarker<Id>`
 *      interface (typed `_<name>` shortcuts + a `(condValue).is.<rel>`
 *      runtime path).
 *   2. Inside `css(...)` / `cva(...)` / `sva(...)` calls, rewrite computed
 *      relational-chain keys (`[m(LITERAL).is.<rel>]`,
 *      `[m._<name>.is.<rel>]`) to literal raw-selector strings. Panda's
 *      parser recognizes those as parent-/self-/combinator-nesting
 *      selectors natively.
 *
 * Nothing else is touched. Utility-string lowering of object *values* is
 * the shorthand plugin's job; the two plugins commute cleanly.
 *
 * Edits are point-precision via magic-string ranges: each computed key is
 * replaced with a quoted string literal, each `marker(...)` declaration's
 * RHS is replaced with the synthesized record. The rest of the source
 * passes through verbatim, so the shorthand plugin (whichever runs after)
 * sees a clean AST when it re-parses.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import MagicString from "magic-string";
import {
  findStyledSystemImports,
  literalStringArg,
  parseSource,
  walk,
  type ImportBindings,
} from "@klinking/panda-utils";
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
 * Per-call binding context: which `marker(...)` declarations are visible
 * at each call site. Includes both local declarations and imports from
 * other files (resolved on demand by reading the imported source).
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
 * Best-effort and intentionally loose: if the file can't be read, or
 * doesn't contain the expected declaration, we silently return undefined.
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

  const ast = parseSource(content);
  if (ast === null) return undefined;

  const bindings = findStyledSystemImports(ast);
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
 * Resolve an import specifier (`./markers.ts`, `../foo/bar`) to the
 * absolute path of the imported file, relative to the importing file.
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

function isValidRelation(name: string): name is MarkerRelation {
  return (MARKER_RELATIONS as readonly string[]).includes(name);
}

/**
 * Match `<binding>(LITERAL).is.<relation>` and `<binding>._<name>.is.<relation>`
 * computed keys. Returns the *raw selector string* Panda will treat as a
 * parent-/self-/combinator-nesting selector, or `null` if the key isn't
 * one of the recognized relational chain shapes.
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
        `@klinking/panda-markers: marker._${condName} references an unregistered condition. ` +
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

/**
 * Walk every css/cva/sva call's argument objects, find computed properties
 * whose key matches a relational chain, and rewrite each such key in place
 * (via magic-string) with a quoted string literal of the resolved raw
 * selector. The property's value is left untouched — the shorthand plugin
 * handles those.
 */
function rewriteRelationalKeys(
  ast: any,
  bindings: ImportBindings,
  source: MagicString,
  rawSource: string,
  markers: MarkerCallContext,
): void {
  walk(ast, (node: any) => {
    if (node?.type !== "CallExpression") return;
    if (node.callee.type !== "Identifier") return;
    const name = node.callee.name;
    if (!(bindings.css.has(name) || bindings.cva.has(name) || bindings.sva.has(name))) return;
    for (const arg of node.arguments) {
      rewriteKeysInArgument(arg, source, rawSource, markers);
    }
  });
}

function rewriteKeysInArgument(
  node: any,
  source: MagicString,
  rawSource: string,
  markers: MarkerCallContext,
): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "ObjectExpression") {
    for (const prop of node.properties) {
      if (prop.type !== "ObjectProperty") continue;
      if (prop.computed) {
        const sel = resolveRelationalKey(prop.key, markers);
        if (sel != null) {
          // Replace the whole `[<expression>]` syntax — including the
          // brackets — with a static string-literal key. Scan outward from
          // the key's range to locate the bracket positions; Babel's
          // ObjectProperty `start` may include leading whitespace, so a
          // direct scan is more reliable than relying on `prop.start`.
          const open = findCharBefore(rawSource, prop.key.start, "[");
          const close = findCharAfter(rawSource, prop.key.end, "]");
          if (open !== -1 && close !== -1) {
            source.overwrite(open, close + 1, JSON.stringify(sel));
          } else {
            source.overwrite(prop.key.start, prop.key.end, JSON.stringify(sel));
          }
        }
      }
      rewriteKeysInArgument(prop.value, source, rawSource, markers);
    }
    return;
  }
  if (node.type === "ArrayExpression") {
    for (const el of node.elements) {
      if (el != null) rewriteKeysInArgument(el, source, rawSource, markers);
    }
  }
}

function findCharBefore(source: string, from: number, ch: string): number {
  for (let i = from - 1; i >= 0; i--) {
    const c = source[i];
    if (c === ch) return i;
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return -1;
  }
  return -1;
}

function findCharAfter(source: string, from: number, ch: string): number {
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (c === ch) return i;
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return -1;
  }
  return -1;
}

/**
 * Inline runtime helper. Composes the five raw-selector strings for a
 * `(condValue, anchorClass)` pair so variable-bound chains (e.g.
 * `const k = m('&:hover').is.ancestor`) work at runtime. Substitutes every
 * `&` in the input with the marker's anchor selector, then runs the
 * `RELATION_SELECTORS` templates against the result.
 *
 * The body is *derived* from `RELATION_SELECTORS` at build time, so the
 * runtime path stays byte-identical to `buildRelationSelector` —
 * no second copy of the selector shapes maintained by hand.
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
 * Discover top-level `const x = marker('id')` declarations. Each becomes
 * a binding the call-site lowering can resolve when it sees relational
 * chain keys.
 *
 * For each declaration, we also rewrite the right-hand side to the
 * synthesized callable record carrying the marker's anchor class, the
 * typed `_<name>` builders (one per registered condition), and a tiny
 * IIFE that handles `(condValue).is.<relation>` chains at runtime.
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
        throw new Error(
          `@klinking/panda-markers: marker() requires a literal string id at ${modulePath}`,
        );
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

export interface TransformInput {
  filePath: string;
  source: string;
}

export interface TransformResult {
  /** New source content, or `undefined` if no change is needed. */
  content: string | undefined;
}

export function transform(input: TransformInput): TransformResult {
  // Cheap early-exit: if the file references neither `marker(` nor a
  // styled-system path, nothing markers-relevant is here. Saves a Babel
  // parse on most files.
  if (!input.source.includes("marker") && !input.source.includes("styled-system")) {
    return { content: undefined };
  }

  const ast = parseSource(input.source, input.filePath);
  if (ast === null) return { content: undefined };

  const bindings = findStyledSystemImports(ast);
  if (
    bindings.marker.size === 0 &&
    bindings.css.size === 0 &&
    bindings.cva.size === 0 &&
    bindings.sva.size === 0
  ) {
    return { content: undefined };
  }

  const ms = new MagicString(input.source);
  const { ctx: markers, needsRelationsHelper } = processMarkerDeclarations(
    ast,
    bindings,
    input.filePath,
    ms,
  );
  rewriteRelationalKeys(ast, bindings, ms, input.source, markers);

  if (needsRelationsHelper) {
    ms.prepend(`${RELATIONS_HELPER_SOURCE}\n`);
  }

  const result = ms.toString();
  return { content: result === input.source ? undefined : result };
}
