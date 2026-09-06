import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "benchmarks/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
    coverage: { reporter: ["text", "json", "html"] }
  }
});
