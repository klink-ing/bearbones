import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import fastGlob from "fast-glob";
import { parse } from "@babel/parser";
import { registerGroup } from "./group-registry.ts";

/**
 * Walk every file the Panda config includes, scan it for top-level
 * `group(...)` declarations imported from `bearbones`, and register each one.
 *
 * Runs in `config:resolved` so the group conditions are present in the
 * resolved config before Panda's extractor starts. This guarantees emitted
 * CSS contains the descendant-selector rules for every declared group.
 *
 * The scan is shallow: it parses each file with Babel but only inspects
 * top-level statements. Reading + parsing files this way is a few ms per
 * file in practice; for large monorepos this can be tuned by narrowing the
 * include glob or moving to a parallel worker pool. (Future work.)
 */
export function prescanGroups(opts: {
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
  if (!content.includes("group(")) return;

  let ast: any;
  try {
    ast = parse(content, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    });
  } catch {
    return;
  }

  let groupBinding: string | null = null;
  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration") continue;
    if (node.source.value !== "bearbones") continue;
    for (const spec of node.specifiers) {
      if (spec.type !== "ImportSpecifier") continue;
      if (spec.imported.name === "group") {
        groupBinding = spec.local.name;
      }
    }
  }
  if (!groupBinding) return;

  for (const node of ast.program.body) {
    const decl =
      node.type === "ExportNamedDeclaration" && node.declaration ? node.declaration : node;
    if (decl.type !== "VariableDeclaration") continue;
    for (const declarator of decl.declarations) {
      if (declarator.id.type !== "Identifier") continue;
      if (declarator.init?.type !== "CallExpression") continue;
      const callee = declarator.init.callee;
      if (callee.type !== "Identifier" || callee.name !== groupBinding) continue;
      const arg = declarator.init.arguments[0];
      if (!arg || arg.type !== "StringLiteral") continue;
      registerGroup(arg.value, resolvePath(absolutePath));
    }
  }
}
