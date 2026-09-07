import { describe, expect, it } from "vitest";
import { defaultBranchPush, installationFromWebhook, repositoryFromWebhook } from "./account-webhook.js";

const repository = { id: 5, name: "store", full_name: "acme/store", private: true, default_branch: "main", owner: { login: "acme" } };

describe("GitHub account webhook identities", () => {
  it("normalizes installations and repositories", () => {
    expect(installationFromWebhook({ installation: { id: 7, account: { id: 8, login: "acme", type: "Organization" }, repository_selection: "all" } })).toMatchObject({ id: 7, accountId: 8, accountLogin: "acme", repositorySelection: "all" });
    expect(repositoryFromWebhook(repository)).toEqual({ id: 5, owner: "acme", repo: "store", fullName: "acme/store", private: true });
  });

  it("accepts only non-deleted default-branch pushes", () => {
    expect(defaultBranchPush({ repository, ref: "refs/heads/main", after: "a".repeat(40) })).toEqual({ owner: "acme", repo: "store", baseRef: "main", baseSha: "a".repeat(40) });
    expect(defaultBranchPush({ repository, ref: "refs/heads/feature", after: "a".repeat(40) })).toBeNull();
    expect(defaultBranchPush({ repository, ref: "refs/heads/main", after: "a".repeat(40), deleted: true })).toBeNull();
  });
});
