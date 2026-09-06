import { z } from "zod";
import type { AiExplanation, Finding } from "@localmesh/shared";

const responseSchema = z.object({
  cause: z.string(), conflictingObjects: z.array(z.string()), forwardFix: z.string(), rollbackFix: z.string(),
  confidence: z.enum(["low","medium","high"]), assumptions: z.array(z.string())
});

export function deterministicExplanation(findings: Finding[]): AiExplanation {
  const first = findings.find((f) => f.severity === "error") ?? findings[0];
  return {
    cause: first?.message ?? "No migration failure was detected.",
    conflictingObjects: findings.flatMap((f) => Array.isArray(f.evidence?.objects) ? f.evidence.objects as string[] : []).slice(0,20),
    forwardFix: "Review the deterministic error and split destructive changes into expand/migrate/contract phases.",
    rollbackFix: "Restore every changed schema object and verify fixture hashes before relying on the rollback.",
    confidence: "high", assumptions: [], source: "deterministic"
  };
}

export async function explainWithOllama(findings: Finding[], migrationSql: string, options: { url:string; model:string; timeoutMs?:number }): Promise<AiExplanation> {
  const fallback = deterministicExplanation(findings);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await fetch(`${options.url.replace(/\/$/,"")}/api/generate`, {
      method:"POST", headers:{"content-type":"application/json"}, signal:controller.signal,
      body:JSON.stringify({ model:options.model, stream:false, format:"json", prompt:[
        "Explain only the verified PostgreSQL migration findings below.",
        "Do not decide pass/fail. Return JSON with cause, conflictingObjects, forwardFix, rollbackFix, confidence, assumptions.",
        JSON.stringify(findings), migrationSql.slice(0,30_000)
      ].join("\n\n") })
    });
    if (!response.ok) return fallback;
    const raw = await response.json() as { response?: string };
    const parsed = responseSchema.safeParse(JSON.parse(raw.response ?? "{}"));
    return parsed.success ? { ...parsed.data, source:"ollama" } : fallback;
  } catch { return fallback; } finally { clearTimeout(timer); }
}
