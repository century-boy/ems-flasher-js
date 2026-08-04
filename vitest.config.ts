import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      /* Run the tests against the sources, so no build step is needed. */
      "@ems-flasher-js/core": new URL("packages/core/src/index.ts", import.meta.url).pathname,
    },
  },
});
