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
      // `vite.config.ts` and `panda.config.ts` import at config-load time,
      // in proper task order. After those one-shot builds finish, `dist/`
      // is populated for both `@klinking/panda-markers` and
      // `@klinking/panda-shorthand` (and transitively `@klinking/panda-utils`),
      // and the website's loader can resolve them.
      //
      // The command launches both plugin watchers in parallel with the
      // website. Each `vp pack --watch` runs with `clean: false` so it
      // incrementally overwrites the just-built bundle in place rather
      // than wiping `dist/` mid-session.
      //
      // Caching: `cache: false` because the body is long-running watchers
      // — nothing meaningful to fingerprint.
      dev: {
        command:
          "vp run @klinking/panda-markers#dev & vp run @klinking/panda-shorthand#dev & vp run website#dev",
        cache: false,
        dependsOn: ["@klinking/panda-markers#build", "@klinking/panda-shorthand#build"],
      },
    },
  },
});
