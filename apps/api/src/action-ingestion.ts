import { parseActionIngestionPayload, verifyActionIngestionSignature, type ActionIngestionPayload } from "@localmesh/shared";

const maximumAgeMs = 15 * 60 * 1000;
const maximumClockLeadMs = 5 * 60 * 1000;

export class ActionIngestionError extends Error {
  constructor(public readonly statusCode: 401 | 422, message: string) {
    super(message);
  }
}

export function authenticateActionIngestion(
  raw: Buffer,
  signature: string | undefined,
  secret: string,
  now = Date.now()
): ActionIngestionPayload {
  if (!verifyActionIngestionSignature(raw, signature, secret)) {
    throw new ActionIngestionError(401, "Invalid Action ingestion signature");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ActionIngestionError(422, "Action ingestion body is not valid JSON");
  }

  let payload: ActionIngestionPayload;
  try {
    payload = parseActionIngestionPayload(parsed);
  } catch {
    throw new ActionIngestionError(422, "Action ingestion body does not match version 1");
  }

  const publishedAt = Date.parse(payload.delivery.publishedAt);
  if (publishedAt < now - maximumAgeMs || publishedAt > now + maximumClockLeadMs) {
    throw new ActionIngestionError(422, "Action ingestion timestamp is outside the accepted window");
  }

  for (const item of payload.results) {
    const expectedExternalId = `localmesh:${payload.delivery.runId}:${payload.delivery.runAttempt}:${item.result.currentPr}`;
    if (item.externalId !== expectedExternalId || item.result.repository !== payload.repository) {
      throw new ActionIngestionError(422, "Action result identity does not match its signed delivery");
    }
  }
  return payload;
}
