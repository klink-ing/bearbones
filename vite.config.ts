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
      // `website#dev` (panda watcher + Vite dev server). The first
      // backgrounds; the second runs in the foreground and keeps the
      // shell alive. Ctrl-C from the terminal sends SIGINT to the whole
      // process group, which the shell + vp propagate to both children
      // — verified empirically, no `trap` needed. Edge case: if the
      // foreground watcher exits unexpectedly mid-session, the
      // backgrounded one orphans. For two long-running dev watchers
      // neither of which is expected to exit, that doesn't justify the
      // extra `& wait` ceremony.
      //
      // Caching: `cache: false` because the body is long-running
      // watchers — nothing meaningful to fingerprint.
      dev: {
        command: "vp run @bearbones/vite#dev & vp run website#dev",
        cache: false,
        dependsOn: ["@bearbones/vite#build", "@bearbones/preset#build"],
      },
    },
  },
});
