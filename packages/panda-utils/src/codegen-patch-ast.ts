/**
 * AST-located splice anchors for plugin codegen patches against Panda's
 * emitted `styled-system/css/css.d.ts`.
 *
 * Parses Panda's `css.d.ts` source with `@babel/parser` (TypeScript mode)
 * and walks the program body to locate two nodes by their AST shape:
 *
 *   1. The `import type { SystemStyleObject } from '../types/index'`
 *      declaration. Plugin-injected blocks splice in immediately after it.
 *
 *   2. The `type Styles = SystemStyleObject | undefined | null | false`
 *      type alias. Plugins may rewrite it (the shorthand plugin widens its
 *      input type) or splice content immediately after it (the markers
 *      plugin appends marker types and the `marker()` declaration).
 *
 * Failure modes are loud and self-diagnosing — if Panda ever changes its
 * output such that one of these nodes can't be located, the thrown error
 * names which node was missing and points at this file for the matcher to
 * update.
 */

import { parse } from "@babel/parser";

export interface CssDtsAnchors {
  /** Byte offset immediately after the `SystemStyleObject` import (insertion point). */
  importEnd: number;
  /** `[start, end)` byte range of the `Styles` type alias declaration (replacement range). */
  stylesRange: [number, number];
}

/**
 * Locate the two anchor positions in Panda's emitted `css.d.ts` source by
 * walking its AST. Throws with a self-diagnosing message if either is
 * absent.
 */
export function locateCssDtsAnchors(source: string): CssDtsAnchors {
  let ast;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: ["typescript"],
    });
  } catch (err) {
    throw new Error(
      `@klinking/panda-utils codegen-patch: failed to parse css.d.ts as TypeScript. ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}. ` +
        `If Panda's emitted format has changed in a way babel-parser can't read, ` +
        `update the matcher in @klinking/panda-utils/codegen-patch-ast.ts.`,
    );
  }

  let importEnd: number | undefined;
  let stylesStart: number | undefined;
  let stylesEnd: number | undefined;

  for (const node of ast.program.body) {
    if (node.type === "ImportDeclaration" && node.source.value === "../types/index") {
      const hasSystemStyleObject = node.specifiers.some(
        (s) => s.type === "ImportSpecifier" && s.local.name === "SystemStyleObject",
      );
      if (hasSystemStyleObject && typeof node.end === "number") {
        importEnd = node.end;
      }
    } else if (node.type === "TSTypeAliasDeclaration" && node.id.name === "Styles") {
      if (typeof node.start === "number" && typeof node.end === "number") {
        stylesStart = node.start;
        stylesEnd = node.end;
      }
    }
  }

  if (importEnd === undefined) {
    throw new Error(
      `@klinking/panda-utils codegen-patch: expected \`SystemStyleObject\` import not found in css.d.ts.\n` +
        `Looking for: an \`import\` declaration from "../types/index" that names \`SystemStyleObject\`.\n` +
        `If Panda changed the import path or specifier name, update the matcher.`,
    );
  }

  if (stylesStart === undefined || stylesEnd === undefined) {
    throw new Error(
      `@klinking/panda-utils codegen-patch: expected \`Styles\` type alias not found in css.d.ts.\n` +
        `Looking for: a top-level \`type Styles = ...\` declaration.\n` +
        `If Panda renamed or restructured the alias, update the matcher.`,
    );
  }

  return { importEnd, stylesRange: [stylesStart, stylesEnd] };
}
