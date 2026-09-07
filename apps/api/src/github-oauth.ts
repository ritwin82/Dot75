import type { AuthConfiguration } from "./auth.js";

export interface GitHubUserIdentity {
  id: number;
  login: string;
  avatarUrl?: string;
  accessToken: string;
}

export function githubAuthorizationUrl(configuration: AuthConfiguration, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", configuration.clientId);
  url.searchParams.set("redirect_uri", `${configuration.publicApiUrl.replace(/\/$/, "")}/auth/github/callback`);
  url.searchParams.set("state", state);
  return url.toString();
}

export function githubInstallationUrl(configuration: AuthConfiguration, state: string): string {
  const url = new URL(`https://github.com/apps/${encodeURIComponent(configuration.appSlug)}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGitHubCode(configuration: AuthConfiguration, code: string): Promise<GitHubUserIdentity> {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "LocalMesh-Sensei" },
    body: JSON.stringify({
      client_id: configuration.clientId,
      client_secret: configuration.clientSecret,
      code,
      redirect_uri: `${configuration.publicApiUrl.replace(/\/$/, "")}/auth/github/callback`
    }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!tokenResponse.ok) throw new Error(`GitHub OAuth token exchange failed with ${tokenResponse.status}.`);
  const tokenPayload = await tokenResponse.json() as { access_token?: string; error?: string };
  if (!tokenPayload.access_token) throw new Error(`GitHub OAuth token exchange failed: ${tokenPayload.error ?? "missing access token"}.`);

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${tokenPayload.access_token}`,
      "user-agent": "LocalMesh-Sensei",
      "x-github-api-version": "2022-11-28"
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!userResponse.ok) throw new Error(`GitHub user lookup failed with ${userResponse.status}.`);
  const user = await userResponse.json() as { id?: number; login?: string; avatar_url?: string };
  if (!Number.isSafeInteger(user.id) || !user.login) throw new Error("GitHub returned an incomplete user identity.");
  return { id: user.id!, login: user.login, accessToken: tokenPayload.access_token, ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}) };
}

export async function userCanAccessInstallation(accessToken: string, installationId: number): Promise<boolean> {
  const response = await fetch(`https://api.github.com/user/installations/${installationId}/repositories?per_page=1`, {
    headers: {
      accept: "application/vnd.github+json", authorization: `Bearer ${accessToken}`,
      "user-agent": "LocalMesh-Sensei", "x-github-api-version": "2022-11-28"
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 403 || response.status === 404) return false;
  if (!response.ok) throw new Error(`GitHub installation authorization failed with ${response.status}.`);
  return true;
}
