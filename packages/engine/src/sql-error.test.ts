import { describe, expect, it } from "vitest";
import { sqlError } from "./runtime.js";
describe("SQL source locations", () => {
  it("maps PostgreSQL character positions across unicode and newlines", () => {
    const sql = "-- 😀\nSELECT missing;";
    expect(sqlError({ code: "42703", position: "13" }, "a.up.sql", sql).line).toBe(2);
  });
  it("does not invent a location without a server position", () => {
    expect(sqlError({ code: "42701" }, "a.up.sql", "ALTER TABLE t;").line).toBeUndefined();
  });
});
