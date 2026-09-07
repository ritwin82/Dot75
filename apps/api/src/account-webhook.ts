import type { GitHubAccountInstallation, GitHubRepositoryAccess } from "@localmesh/shared";

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`GitHub webhook is missing ${label}.`);
  return value as Record<string, any>;
}

export function installationFromWebhook(payload: Record<string, any>, status: GitHubAccountInstallation["status"] = "active"): GitHubAccountInstallation {
  const installation = record(payload.installation, "installation");
  const account = record(installation.account, "installation account");
  const id = Number(installation.id);
  const accountId = Number(account.id);
  const accountLogin = String(account.login ?? account.slug ?? "");
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(accountId) || !accountLogin) throw new Error("GitHub webhook contains an invalid installation identity.");
  return {
    id, accountId, accountLogin, accountType: String(account.type ?? "Unknown"),
    repositorySelection: String(installation.repository_selection ?? "selected"), status
  };
}

export function repositoryFromWebhook(value: unknown): GitHubRepositoryAccess {
  const repository = record(value, "repository");
  const owner = record(repository.owner, "repository owner");
  const id = Number(repository.id);
  const ownerLogin = String(owner.login ?? "");
  const repo = String(repository.name ?? "");
  if (!Number.isSafeInteger(id) || !ownerLogin || !repo) throw new Error("GitHub webhook contains an invalid repository identity.");
  return { id, owner: ownerLogin, repo, fullName: String(repository.full_name ?? `${ownerLogin}/${repo}`), private: repository.private === true };
}

export function defaultBranchPush(payload: Record<string, any>): { owner: string; repo: string; baseRef: string; baseSha: string } | null {
  const repository = record(payload.repository, "repository");
  const baseRef = String(repository.default_branch ?? "");
  const ref = String(payload.ref ?? "");
  const baseSha = String(payload.after ?? "");
  if (!baseRef || ref !== `refs/heads/${baseRef}` || payload.deleted === true) return null;
  if (!/^[a-f0-9]{40}$/i.test(baseSha)) throw new Error("GitHub push webhook contains an invalid target revision.");
  return { owner: String(record(repository.owner, "repository owner").login), repo: String(repository.name), baseRef, baseSha };
}
