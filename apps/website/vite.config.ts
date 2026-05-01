import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { bearbonesVitePlugin } from "@bearbones/vite";

export default defineConfig({
  // bearbonesVitePlugin must come first so its `enforce: 'pre'` lowering
  // runs before React's JSX transform sees the source. Without this, utility
  // strings reach the browser and Panda's runtime css() can't resolve them.
  plugins: [bearbonesVitePlugin(), react()],
});
