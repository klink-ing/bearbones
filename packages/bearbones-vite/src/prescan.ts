import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import fastGlob from "fast-glob";
import { parse } from "@babel/parser";
import {
  MARKER_STATES,
  type MarkerState,
  MARKER_RELATIONS,
  type MarkerRelation,
  STATE_PSEUDO,
  registerMarker,
  registerMarkerCondition,
} from "./marker-registry.ts";

/**
 * Walk every file the Panda config includes, scan it for top-level
 * `marker(...)` declarations imported from `bearbones`, and register each one.
 *
 * Runs in `config:resolved` so the marker conditions are present in the
 * resolved config before Panda's extractor starts. This guarantees emitted
 * CSS contains the descendant-selector rules for every declared marker.
 *
 * The scan is shallow for declarations (top-level only) but DEEP for usage
 * sites: we walk the entire AST looking for `<binding>(LITERAL).is.<relation>`
 * and `<binding>._<state>.is.<relation>` chains so we can register the
 * resulting conditions before Panda's extractor runs. Reading + parsing files
 * this way is a few ms per file in practice; for large monorepos this can be
 * tuned by narrowing the include glob or moving to a parallel worker pool.
 * (Future work.)
 */
export function prescanMarkers(opts: {
  cwd: string;
  include: readonly string[];
  exclude: readonly string[];
}): void {
  const files = fastGlob.sync([...opts.include], {
    cwd: opts.cwd,
    ignore: [...opts.exclude],
    absolute: true,
  });
  for (const file of files) {
    scanFile(file);
  }
}

function scanFile(absolutePath: string): void {
  let content: string;
  try {
    content = readFileSync(absolutePath, "utf8");
  } catch {
    return;
  }
  // Cheap rejection: skip files that don't import from bearbones at all.
  if (!content.includes("bearbones")) return;
  if (!content.includes("marker(") && !content.includes(".is.")) return;

  let ast: any;
  try {
    ast = parse(content, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    });
  } catch {
    return;
  }

  let markerBinding: string | null = null;
  // localName → relative import specifier (e.g. `cardMarker → "./markers.ts"`).
  // We resolve each to an absolute file path on demand below.
  const importedMarkerBindings = new Map<string, string>();
  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration") continue;
    const source = node.source.value;
    if (source === "bearbones") {
      for (const spec of node.specifiers) {
        if (spec.type !== "ImportSpecifier") continue;
        if (spec.imported.name === "marker") {
          markerBinding = spec.local.name;
        }
      }
      continue;
    }
    // Track every other import — it might be where a marker was declared.
    // We can't tell from the import alone, so we lazily resolve below if any
    // local binding name shows up in a chain.
    for (const spec of node.specifiers) {
      if (spec.type !== "ImportSpecifier") continue;
      importedMarkerBindings.set(spec.local.name, source);
    }
  }

  // Pass 1: register every top-level `const x = marker('id')` declaration in
  // THIS file. Local bindings are the most common case and the cheapest to
  // resolve.
  const bindings = new Map<string, { id: string; modulePath: string }>();
  if (markerBinding) {
    for (const node of ast.program.body) {
      const decl =
        node.type === "ExportNamedDeclaration" && node.declaration ? node.declaration : node;
      if (decl.type !== "VariableDeclaration") continue;
      for (const declarator of decl.declarations) {
        if (declarator.id.type !== "Identifier") continue;
        if (declarator.init?.type !== "CallExpression") continue;
        const callee = declarator.init.callee;
        if (callee.type !== "Identifier" || callee.name !== markerBinding) continue;
        const arg = declarator.init.arguments[0];
        if (!arg || arg.type !== "StringLiteral") continue;
        const modulePath = resolvePath(absolutePath);
        registerMarker(arg.value, modulePath);
        bindings.set(declarator.id.name, { id: arg.value, modulePath });
      }
    }
  }

  // Pass 2: walk the entire AST to find `(LITERAL).is.<rel>` and
  // `._<state>.is.<rel>` chains. Resolve binding identifiers against local
  // declarations first; for unrecognized identifiers, fall back to imported
  // bindings (lazily reading the imported file's `marker(...)` declarations).
  walk(ast, (node: any) => {
    if (node?.type !== "MemberExpression") return;
    const innerBindingName = chainBindingName(node);
    if (!innerBindingName) return;
    let binding = bindings.get(innerBindingName);
    if (!binding) {
      const specifier = importedMarkerBindings.get(innerBindingName);
      if (!specifier) return;
      const importedPath = resolveRelativeImport(absolutePath, specifier);
      if (!importedPath) return;
      const id = findExportedMarkerId(importedPath, innerBindingName);
      if (!id) return;
      registerMarker(id, importedPath);
      binding = { id, modulePath: importedPath };
      bindings.set(innerBindingName, binding);
    }
    const chain = matchRelationChain(node, new Map([[innerBindingName, { id: binding.id }]]));
    if (!chain) return;
    registerMarkerCondition(chain.id, binding.modulePath, chain.modifier, chain.relation);
  });
}

/**
 * Extract the inner identifier of a `<binding>(...).is.<rel>` or
 * `<binding>._<state>.is.<rel>` chain without committing to a full match. We
 * use this to decide whether to lazily resolve a cross-file marker import.
 */
function chainBindingName(outer: any): string | null {
  if (outer.computed) return null;
  if (outer.property?.type !== "Identifier") return null;
  if (!isRelation(outer.property.name)) return null;
  const middle = outer.object;
  if (middle?.type !== "MemberExpression" || middle.computed) return null;
  if (middle.property?.type !== "Identifier" || middle.property.name !== "is") return null;
  const inner = middle.object;
  if (inner?.type === "CallExpression") {
    if (inner.callee.type !== "Identifier") return null;
    return inner.callee.name;
  }
  if (inner?.type === "MemberExpression" && !inner.computed) {
    if (inner.object.type !== "Identifier") return null;
    return inner.object.name;
  }
  return null;
}

/**
 * Resolve an import specifier (`./markers.ts`, `../foo/bar`) to the absolute
 * path of the imported file. Mirrors the transform helper of the same name —
 * deliberately kept duplicate to avoid a circular import; the implementations
 * are tiny.
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
 * Find a top-level `export const <bindingName> = marker('<id>')` in the file
 * at `absolutePath` and return the literal `<id>`. Used to resolve imported
 * marker bindings to their declarations during prescan's Pass 2.
 */
function findExportedMarkerId(absolutePath: string, bindingName: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(absolutePath, "utf8");
  } catch {
    return undefined;
  }
  if (!content.includes("marker(")) return undefined;
  let ast: any;
  try {
    ast = parse(content, { sourceType: "module", plugins: ["typescript", "jsx"] });
  } catch {
    return undefined;
  }
  let markerImport: string | null = null;
  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration") continue;
    if (node.source.value !== "bearbones") continue;
    for (const spec of node.specifiers) {
      if (spec.type !== "ImportSpecifier") continue;
      if (spec.imported.name === "marker") markerImport = spec.local.name;
    }
  }
  if (!markerImport) return undefined;
  for (const node of ast.program.body) {
    const decl =
      node.type === "ExportNamedDeclaration" && node.declaration ? node.declaration : node;
    if (decl.type !== "VariableDeclaration") continue;
    for (const declarator of decl.declarations) {
      if (declarator.id.type !== "Identifier") continue;
      if (declarator.id.name !== bindingName) continue;
      if (declarator.init?.type !== "CallExpression") continue;
      const callee = declarator.init.callee;
      if (callee.type !== "Identifier" || callee.name !== markerImport) continue;
      const arg = declarator.init.arguments[0];
      if (!arg || arg.type !== "StringLiteral") continue;
      return arg.value;
    }
  }
  return undefined;
}

interface RelationChain {
  id: string;
  modifier: string;
  relation: MarkerRelation;
}

/**
 * Match either of:
 *   - `<binding>(LITERAL).is.<rel>`  — call form
 *   - `<binding>._<state>.is.<rel>`  — underscore form
 *
 * Both shapes parse as `MemberExpression { object: <inner>.is, property: <rel> }`.
 * Returns the (id, modifier, relation) triple to register, or `null` if the
 * outermost MemberExpression isn't one of the two recognized chain shapes.
 *
 * Conservative on purpose: dynamic relation (`.is[rel]`), template literals
 * with expressions, and any non-literal modifier produce `null` so we don't
 * register half-formed conditions. The transform applies the same constraints
 * at lower-time, so unmatched chains land at runtime as `cardMarker is not a
 * function` (clear enough error).
 */
function matchRelationChain(
  outer: any,
  localBindings: Map<string, { id: string }>,
): RelationChain | null {
  // Outer: `.is.<relation>`
  if (outer.computed) return null;
  if (outer.property.type !== "Identifier") return null;
  const relation = outer.property.name as string;
  if (!isRelation(relation)) return null;

  // Middle: `<inner>.is`
  const middle = outer.object;
  if (middle?.type !== "MemberExpression") return null;
  if (middle.computed) return null;
  if (middle.property.type !== "Identifier" || middle.property.name !== "is") return null;

  // Inner: either `<binding>(LITERAL)` or `<binding>._<state>`
  const inner = middle.object;
  if (inner?.type === "CallExpression") {
    if (inner.callee.type !== "Identifier") return null;
    const binding = localBindings.get(inner.callee.name);
    if (!binding) return null;
    const arg = inner.arguments[0];
    const modifier = literalString(arg);
    if (modifier == null) return null;
    return { id: binding.id, modifier, relation };
  }
  if (inner?.type === "MemberExpression") {
    if (inner.computed) return null;
    if (inner.object.type !== "Identifier") return null;
    const binding = localBindings.get(inner.object.name);
    if (!binding) return null;
    if (inner.property.type !== "Identifier") return null;
    const propName = inner.property.name as string;
    if (!propName.startsWith("_")) return null;
    const stateName = propName.slice(1);
    if (!isState(stateName)) return null;
    return { id: binding.id, modifier: STATE_PSEUDO[stateName], relation };
  }
  return null;
}

function isRelation(name: string): name is MarkerRelation {
  return (MARKER_RELATIONS as readonly string[]).includes(name);
}

function isState(name: string): name is MarkerState {
  return (MARKER_STATES as readonly string[]).includes(name);
}

function literalString(arg: any): string | null {
  if (!arg) return null;
  if (arg.type === "StringLiteral") return arg.value;
  if (arg.type === "TemplateLiteral" && arg.expressions.length === 0) {
    return arg.quasis.map((q: any) => q.value.cooked).join("");
  }
  return null;
}

/**
 * Tiny depth-first walker. Avoids pulling in @babel/traverse, which is heavy
 * and has its own deps. Mirrors the walker in transform.ts.
 */
function walk(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const k of Object.keys(node)) {
    if (k === "loc" || k === "range") continue;
    walk(node[k], visit);
  }
}
