import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("applies safe defaults", () => {
    const config = parseConfig("version: 1\npostgres: {}\nmigrations: {}\n");
    expect(config.postgres.version).toBe("16");
    expect(config.checks.compare_open_pull_requests).toBe(true);
    expect(config.checks.max_group_size).toBe(3);
    expect(config.migrations.adapter).toBe("raw-sql");
  });
  it("rejects shell-like extension names", () => {
    expect(() => parseConfig("version: 1\npostgres:\n  extensions: ['x;drop']\nmigrations: {}\n")).toThrow();
  });
  it("accepts version 2 execution and fixture-state settings", () => {
    const config = parseConfig("version: 2\npostgres: {}\nmigrations:\n  adapter: prisma\nchecks:\n  max_group_size: 2\ndata_state:\n  exclude_columns: [public.events.created_at]\n");
    expect(config.migrations.adapter).toBe("prisma");
    expect(config.data_state.exclude_columns).toEqual(["public.events.created_at"]);
  });
});
