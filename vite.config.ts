import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: { options: { typeAware: true, typeCheck: true } },
  run: {
    cache: true,
    tasks: {
      // Orchestration of the full dev pipeline.
      //
      // `dependsOn` pre-builds every workspace dist the website's
      // `vite.config.ts` and `panda.config.ts` import at config-load
      // time, in proper task order. After those one-shot builds finish,
      // `dist/` is populated for both `@bearbones/vite` and
      // `@bearbones/preset`, and the website's loader can resolve them.
      //
      // The command then launches the two long-running watchers in
      // parallel: `@bearbones/vite#dev` (a `vp pack --watch` with
      // `clean: false`, so it incrementally overwrites the just-built
      // bundle in place rather than wiping `dist/` first) and
      // `website#dev` (panda watcher + Vite dev server). `trap` kills
      // the whole process group on SIGINT/SIGTERM so Ctrl-C stops
      // both children.
      //
      // Caching: `cache: false` because the body is long-running
      // watchers — nothing meaningful to fingerprint.
      dev: {
        command: "trap 'kill 0' INT TERM; vp run @bearbones/vite#dev & vp run website#dev & wait",
        cache: false,
        dependsOn: ["@bearbones/vite#build", "@bearbones/preset#build"],
      },
    },
  },
});
