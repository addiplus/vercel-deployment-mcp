import { defineConfig } from "vitest/config";

// Pin vitest to this project. Without a local config, vitest walks up the
// directory tree and can adopt an unrelated parent vite/vitest config
// (plugins, setup files) from a monorepo or grouping folder.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: [],
  },
});
