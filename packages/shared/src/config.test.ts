import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("applies safe defaults", () => {
    const config = parseConfig("version: 1\npostgres: {}\nmigrations: {}\n");
    expect(config.postgres.version).toBe("16");
    expect(config.checks.compare_open_pull_requests).toBe(true);
  });
  it("rejects shell-like extension names", () => {
    expect(() => parseConfig("version: 1\npostgres:\n  extensions: ['x;drop']\nmigrations: {}\n")).toThrow();
  });
});
