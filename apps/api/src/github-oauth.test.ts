import { describe, expect, it } from "vitest";
import { githubAuthorizationUrl, githubInstallationUrl } from "./github-oauth.js";

const configuration = { clientId: "client", clientSecret: "secret", appSlug: "localmesh-sensei", sessionSecret: "session", publicApiUrl: "https://api.localmesh.dev", webOrigin: "https://app.localmesh.dev" };

describe("GitHub account URLs", () => {
  it("binds OAuth callbacks to the public API", () => {
    const url = new URL(githubAuthorizationUrl(configuration, "signed-state"));
    expect(url.hostname).toBe("github.com");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.localmesh.dev/auth/github/callback");
    expect(url.searchParams.get("state")).toBe("signed-state");
  });

  it("creates the App installation URL with signed state", () => {
    const url = new URL(githubInstallationUrl(configuration, "installation-state"));
    expect(url.pathname).toBe("/apps/localmesh-sensei/installations/new");
    expect(url.searchParams.get("state")).toBe("installation-state");
  });
});
