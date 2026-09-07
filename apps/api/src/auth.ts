import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const sessionCookieName = "localmesh_session";
export const oauthStateCookieName = "localmesh_oauth_state";

export interface AuthConfiguration {
  clientId: string;
  clientSecret: string;
  appSlug: string;
  sessionSecret: string;
  publicApiUrl: string;
  webOrigin: string;
  cookieDomain?: string;
}

export interface SessionIdentity {
  userId: number;
  login: string;
}

interface SignedClaims {
  purpose: "session" | "oauth" | "installation";
  exp: number;
  nonce: string;
  userId?: number;
  login?: string;
}

function configured(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function authConfiguration(): AuthConfiguration | undefined {
  const values = {
    clientId: configured("GITHUB_CLIENT_ID"),
    clientSecret: configured("GITHUB_CLIENT_SECRET"),
    appSlug: configured("GITHUB_APP_SLUG"),
    sessionSecret: configured("LOCALMESH_SESSION_SECRET"),
    publicApiUrl: configured("PUBLIC_API_URL"),
    webOrigin: configured("WEB_ORIGIN")
  };
  const hostedValues = [values.clientId, values.clientSecret, values.appSlug, values.sessionSecret, values.publicApiUrl];
  if (!hostedValues.some(Boolean)) return undefined;
  const missing = Object.entries(values).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Hosted GitHub authentication is incomplete: ${missing.join(", ")}.`);
  return {
    clientId: values.clientId!, clientSecret: values.clientSecret!, appSlug: values.appSlug!,
    sessionSecret: values.sessionSecret!, publicApiUrl: values.publicApiUrl!, webOrigin: values.webOrigin!,
    ...(configured("SESSION_COOKIE_DOMAIN") ? { cookieDomain: configured("SESSION_COOKIE_DOMAIN")! } : {})
  };
}

function encode(claims: SignedClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decode(token: string | undefined, secret: string, purpose: SignedClaims["purpose"], now = Date.now()): SignedClaims | undefined {
  if (!token) return undefined;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return undefined;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const receivedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<SignedClaims>;
    if (claims.purpose !== purpose || typeof claims.exp !== "number" || claims.exp <= now || typeof claims.nonce !== "string") return undefined;
    return claims as SignedClaims;
  } catch {
    return undefined;
  }
}

export function createOAuthState(secret: string, now = Date.now()): string {
  return encode({ purpose: "oauth", exp: now + 10 * 60_000, nonce: randomBytes(24).toString("base64url") }, secret);
}

export function verifyOAuthState(state: string | undefined, cookieState: string | undefined, secret: string, now = Date.now()): boolean {
  if (!state || !cookieState || state !== cookieState) return false;
  return Boolean(decode(state, secret, "oauth", now));
}

export function createSession(identity: SessionIdentity, secret: string, now = Date.now()): string {
  return encode({ purpose: "session", exp: now + 12 * 60 * 60_000, nonce: randomBytes(16).toString("base64url"), ...identity }, secret);
}

export function readSession(cookieHeader: string | undefined, secret: string, now = Date.now()): SessionIdentity | undefined {
  const claims = decode(readCookie(cookieHeader, sessionCookieName), secret, "session", now);
  if (!claims || !Number.isSafeInteger(claims.userId) || !claims.login) return undefined;
  return { userId: claims.userId!, login: claims.login };
}

export function createInstallationState(identity: SessionIdentity, secret: string, now = Date.now()): string {
  return encode({ purpose: "installation", exp: now + 30 * 60_000, nonce: randomBytes(24).toString("base64url"), ...identity }, secret);
}

export function readInstallationState(state: string | undefined, secret: string, now = Date.now()): SessionIdentity | undefined {
  const claims = decode(state, secret, "installation", now);
  if (!claims || !Number.isSafeInteger(claims.userId) || !claims.login) return undefined;
  return { userId: claims.userId!, login: claims.login };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

export function sessionCookie(value: string, configuration: AuthConfiguration, maxAge = 12 * 60 * 60): string {
  const secure = new URL(configuration.publicApiUrl).protocol === "https:";
  return [
    `${sessionCookieName}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax",
    `Max-Age=${maxAge}`, ...(secure ? ["Secure"] : []), ...(configuration.cookieDomain ? [`Domain=${configuration.cookieDomain}`] : [])
  ].join("; ");
}

export function shortCookie(name: string, value: string, configuration: AuthConfiguration, maxAge = 600): string {
  const secure = new URL(configuration.publicApiUrl).protocol === "https:";
  return [
    `${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax",
    `Max-Age=${maxAge}`, ...(secure ? ["Secure"] : []), ...(configuration.cookieDomain ? [`Domain=${configuration.cookieDomain}`] : [])
  ].join("; ");
}

export function sealCredential(value: string, secret: string): string {
  const key = createHash("sha256").update("localmesh-github-user-token\0").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function openCredential(value: string, secret: string): string {
  const [ivText, tagText, ciphertextText] = value.split(".");
  if (!ivText || !tagText || !ciphertextText) throw new Error("Stored GitHub credential is malformed.");
  const key = createHash("sha256").update("localmesh-github-user-token\0").update(secret).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}
