import { describe, expect, it } from "vitest";
import { installationRecord, repositoryRecord } from "./index.js";

describe("GitHub App account records", () => {
  it("normalizes installation and repository identities", () => {
    expect(installationRecord({ id: 7, account: { id: 9, login: "acme", type: "Organization" }, repository_selection: "selected", suspended_at: null })).toEqual({
      id: 7, accountId: 9, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", status: "active"
    });
    expect(repositoryRecord({ id: 11, name: "store", full_name: "acme/store", private: true, owner: { login: "acme" } })).toEqual({
      id: 11, owner: "acme", repo: "store", fullName: "acme/store", private: true
    });
  });

  it("rejects incomplete installation identities", () => {
    expect(() => installationRecord({ id: 7, account: null, repository_selection: "all", suspended_at: null })).toThrow("no account identity");
  });
});
