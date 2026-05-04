/**
 * Shared template loader contract.
 *
 * Each plugin keeps its templates as real `.ts` files under `src/templates/`,
 * inlined at build / test setup time into a per-plugin `templates.generated.ts`
 * via the `inline-templates` Vite plugin from `@klinking/panda-utils/build`.
 * Plugins pass a `TemplateLoader` (typically `(name) => TEMPLATES[name]`) to
 * the helpers here that need to read template bodies — keeping this layer
 * loader-agnostic means each plugin owns its own template namespace and
 * `templates.generated.ts` file without importing the others.
 */

export type TemplateLoader = (name: string) => string;

/**
 * Sentinel comment that splits each template file into "metadata above"
 * (template-author notes, type-resolution shims) and "emit body below".
 * Renderers strip everything up to and including this fence; only the body
 * is spliced into Panda's emitted artifacts.
 */
export const TEMPLATE_FENCE = "// ---bearbones-template-emit-below---";

/**
 * Read the body portion of a template — i.e. everything after `TEMPLATE_FENCE`,
 * with the leading newline trimmed. Throws if the fence is absent (template
 * file is malformed).
 */
export function loadTemplateBody(name: string, loader: TemplateLoader): string {
  const source = loader(name);
  const idx = source.indexOf(TEMPLATE_FENCE);
  if (idx < 0) {
    throw new Error(
      `@klinking/panda-utils: template ${JSON.stringify(name)} is missing the ` +
        `"${TEMPLATE_FENCE}" fence. Add the fence right before the content that should ` +
        `be emitted.`,
    );
  }
  let body = source.slice(idx + TEMPLATE_FENCE.length);
  if (body.startsWith("\n")) body = body.slice(1);
  return body;
}
