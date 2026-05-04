import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { markersVitePlugin } from "@klinking/panda-markers";
import { shorthandVitePlugin } from "@klinking/panda-shorthand";

export default defineConfig({
  // Both plugins must come before React so their `enforce: 'pre'` lowering
  // runs before React's JSX transform sees the source. Without this,
  // marker chains and utility strings reach the browser and Panda's
  // runtime can't resolve them.
  //
  // Markers runs first so any rewritten relational keys are already
  // literal strings by the time shorthand walks the AST.
  plugins: [markersVitePlugin(), shorthandVitePlugin(), react()],
});
