import { signActionIngestion, type ActionIngestionPayload, type PublishedActionResult } from "@localmesh/shared";

export interface PlatformDelivery {
  repository: string;
  runId: number;
  runAttempt: number;
  results: PublishedActionResult[];
}

export async function sendPlatformResults(baseUrl: string, secret: string, delivery: PlatformDelivery): Promise<number> {
  const url = new URL("/api/action-results", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("LOCALMESH_PLATFORM_URL must use http or https.");
  const payload: ActionIngestionPayload = {
    version: 1,
    repository: delivery.repository,
    delivery: {
      event: "workflow_run",
      runId: delivery.runId,
      runAttempt: delivery.runAttempt,
      publishedAt: new Date().toISOString()
    },
    results: delivery.results
  };
  const body = JSON.stringify(payload);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-localmesh-signature-256": signActionIngestion(body, secret)
    },
    body,
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`LocalMesh dashboard ingestion failed (${response.status}): ${detail || response.statusText}`);
  }
  return delivery.results.length;
}
