import type { ValidationJob } from "@localmesh/shared";

type ValidationTarget = Omit<ValidationJob, "id" | "installationId" | "checkRunId">;
interface BranchClient {
  repos: { getBranch(input: { owner: string; repo: string; branch: string }): Promise<{ data: { commit: { sha: string } } }> };
}

/** Queue parents can contain unmerged PR policy changes; trust the live target branch instead. */
export async function resolveValidationBase(client: BranchClient, input: ValidationTarget, event: string | undefined, payload: Record<string, any>): Promise<ValidationTarget> {
  if (event !== "merge_group") return input;
  const ref: unknown = payload.merge_group?.base_ref;
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/") || ref.length === "refs/heads/".length) throw new Error("Merge group validation requires a target branch ref under refs/heads/.");
  const { data } = await client.repos.getBranch({ owner: input.owner, repo: input.repo, branch: ref.slice("refs/heads/".length) });
  if (!/^[a-f0-9]{40}$/i.test(data.commit.sha)) throw new Error("GitHub returned an invalid immutable target branch SHA.");
  return { ...input, baseSha: data.commit.sha };
}

export function extractPullRequest(event: string | undefined, payload: Record<string, any>): ValidationTarget | null {
  if (event === "pull_request" && ["opened", "synchronize", "reopened", "ready_for_review"].includes(String(payload.action))) {
    const pr = payload.pull_request;
    return { owner: String(payload.repository.owner.login), repo: String(payload.repository.name), prNumber: Number(pr.number), headSha: String(pr.head.sha), baseSha: String(pr.base.sha) };
  }
  if (event === "merge_group" && payload.action === "checks_requested") {
    const group = payload.merge_group;
    // A queue head can contain multiple PRs. Validate its full diff in the base
    // repository instead of guessing one PR from an implementation-specific ref.
    return { owner: String(payload.repository.owner.login), repo: String(payload.repository.name), prNumber: 0, headSha: String(group.head_sha), baseSha: String(group.base_sha) };
  }
  return null;
}
