import { afterEach, describe, expect, it, vi } from "vitest";
import { authConfiguration, createInstallationState, createOAuthState, createSession, openCredential, readInstallationState, readSession, sealCredential, sessionCookie, verifyOAuthState } from "./auth.js";

describe("hosted account authentication", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps hosted authentication disabled for a local CORS origin", () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "");
    vi.stubEnv("GITHUB_APP_SLUG", "");
    vi.stubEnv("LOCALMESH_SESSION_SECRET", "");
    vi.stubEnv("PUBLIC_API_URL", "");
    vi.stubEnv("WEB_ORIGIN", "http://localhost:3000");

    expect(authConfiguration()).toBeUndefined();
  });

  it("binds OAuth state to the initiating browser", () => {
    const state = createOAuthState("secret", 1_000);
    expect(verifyOAuthState(state, state, "secret", 2_000)).toBe(true);
    expect(verifyOAuthState(state, `${state}x`, "secret", 2_000)).toBe(false);
    expect(verifyOAuthState(state, state, "secret", 11 * 60_000)).toBe(false);
  });

  it("accepts signed sessions and rejects tampering or expiration", () => {
    const token = createSession({ userId: 42, login: "octocat" }, "secret", 1_000);
    expect(readSession(`other=x; localmesh_session=${token}`, "secret", 2_000)).toEqual({ userId: 42, login: "octocat" });
    expect(readSession(`localmesh_session=${token}x`, "secret", 2_000)).toBeUndefined();
    expect(readSession(`localmesh_session=${token}`, "secret", 8 * 24 * 60 * 60_000)).toBeUndefined();
  });

  it("ties installation callbacks to an authenticated user", () => {
    const state = createInstallationState({ userId: 42, login: "octocat" }, "secret", 1_000);
    expect(readInstallationState(state, "secret", 2_000)).toEqual({ userId: 42, login: "octocat" });
  });

  it("emits secure shared-domain cookies for hosted deployments", () => {
    const cookie = sessionCookie("token", { clientId: "id", clientSecret: "secret", appSlug: "localmesh", sessionSecret: "session", publicApiUrl: "https://api.example.com", webOrigin: "https://app.example.com", cookieDomain: ".example.com" });
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Domain=.example.com");
    expect(cookie).toContain("HttpOnly");
  });

  it("encrypts GitHub user credentials at rest", () => {
    const encrypted = sealCredential("github-user-token", "session-secret");
    expect(encrypted).not.toContain("github-user-token");
    expect(openCredential(encrypted, "session-secret")).toBe("github-user-token");
    expect(() => openCredential(encrypted, "another-secret")).toThrow();
  });
});
