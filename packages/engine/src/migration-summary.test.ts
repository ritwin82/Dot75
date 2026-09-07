import { describe, expect, it } from "vitest";
import { summarizeMigrationOperations } from "./migration-summary.js";

describe("migration operation summaries", () => {
  it("explains common table and data changes without storing SQL", () => {
    const operations = summarizeMigrationOperations([{
      path: "db/migrations/002_accounts.up.sql",
      direction: "up",
      order: 2,
      sql: "ALTER TABLE public.accounts ADD COLUMN status text; UPDATE public.accounts SET status = 'active'; ALTER TABLE public.accounts RENAME COLUMN status TO state;"
    }]);
    expect(operations.map((item) => item.description)).toEqual([
      "Adds column status to public.accounts.",
      "Updates rows in public.accounts.",
      "Renames public.accounts.status to state."
    ]);
    expect(JSON.stringify(operations)).not.toContain("'active'");
  });
});
