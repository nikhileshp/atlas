import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, ".") },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // integration tests (rls/seed) talk to the live local stack; keep them
    // out of the default unit run via the `test` vs `test:integration` scripts
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    // integration files share one live database; running them in parallel
    // makes seed-shape assertions race against users.test fixtures
    fileParallelism: false,
  },
});
