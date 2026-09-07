import { describe, expect, it } from "vitest";
import { eventTarget } from "./discover.js";
const repository = { name: "demo", owner: { login: "owner" }, default_branch: "main" };
const head = "a".repeat(40), base = "b".repeat(40);
describe("Action trigger identity", () => {
  it("uses PR head rather than GitHub's synthetic checkout SHA", () => {
    expect(eventTarget("pull_request", { repository, pull_request: { number: 12, head: { sha: head }, base: { ref: "main" } } })).toMatchObject({ prNumber: 12, headSha: head, baseRef: "main" });
  });
  it("refreshes only default-branch pushes", () => {
    expect(() => eventTarget("push", { repository, ref: "refs/heads/topic", after: base })).toThrow(/default branch/);
    expect(eventTarget("push", { repository, ref: "refs/heads/main", after: base }).baseSha).toBe(base);
  });
  it("validates the entire merge group using the group base and head", () => {
    expect(eventTarget("merge_group", { repository, merge_group: { base_sha: base, head_sha: head, base_ref: "refs/heads/main", head_ref: "refs/heads/gh-readonly-queue/main/pr-12-x" } })).toMatchObject({ prNumber: 0, baseSha: base, headSha: head });
  });
  it("rejects mutable refs and deleted branches", () => {
    expect(() => eventTarget("push", { repository, ref: "refs/heads/main", after: "main" })).toThrow();
    expect(() => eventTarget("push", { repository, ref: "refs/heads/main", after: base, deleted: true })).toThrow();
  });
});
