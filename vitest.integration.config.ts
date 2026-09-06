import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.integration.test.ts", "apps/*/src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 120000,
    hookTimeout: 120000
  }
});
