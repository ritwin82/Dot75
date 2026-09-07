import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ensureSchema, pool, saveJob, setJobStatus } from "@localmesh/db";
import { deterministicExplanation, explainWithOllama, PostgresValidationEnvironment } from "@localmesh/engine";
import type { ValidationJob } from "@localmesh/shared";
import { demoScenarios } from "./demo-scenarios.js";
import { explanationContext, resultFindings, runValidationPlan } from "./validation-plan.js";

// Local simulated PRs with real SQL, shared worker validation and real local AI.
// --no-ai is useful for a fast deterministic regression run.
let environment: PostgresValidationEnvironment | undefined;
try {
  await ensureSchema();
  environment = await PostgresValidationEnvironment.start("16");
  const selected = process.argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1];
  if (selected && !demoScenarios.some((scenario) => scenario.name === selected)) throw new Error(`Unknown demo scenario: ${selected}`);
  for (const scenario of demoScenarios.filter((scenario) => !selected || scenario.name === selected)) {
    const job: ValidationJob = { id: randomUUID(), installationId: 0, owner: "local-demo", repo: scenario.name, prNumber: scenario.plan.current.pr, headSha: randomUUID(), baseSha: "local-demo-baseline" };
    await saveJob(job);
    await setJobStatus(job.id, "running");
    try {
      const result = await runValidationPlan(environment, job, scenario.plan);
      const findings = resultFindings(result);
      assert.equal(result.status === "passed", scenario.expectedPassed, scenario.name);
      if (scenario.expectedCode) assert(findings.some((finding) => finding.code === scenario.expectedCode), scenario.expectedCode);
      if (scenario.singlesPass) assert(result.orders.filter((order) => order.order.length === 1).every((order) => order.passed), "Individual PRs must pass");
      const ai = !process.argv.includes("--no-ai");
      result.explanation = deterministicExplanation(findings);
      result.explanationStatus = ai ? "pending" : "complete";
      await setJobStatus(job.id, result.status, result);
      console.log(JSON.stringify({ scenario: scenario.name, databaseVerified: true, status: result.status, url: `http://localhost:3000/jobs/${job.id}` }));
      if (ai) {
        result.explanation = await explainWithOllama(findings, explanationContext(scenario.plan, result), { url: process.env.OLLAMA_URL ?? "http://localhost:11434", model: process.env.OLLAMA_MODEL ?? "qwen2.5-coder:3b", timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 120000) });
        result.explanationStatus = "complete";
        await setJobStatus(job.id, result.status, result);
        console.log(JSON.stringify({ scenario: scenario.name, explanation: result.explanation.source, model: result.explanation.model, durationMs: result.explanation.durationMs, fallback: result.explanation.fallbackReason }));
      }
    } catch (error) {
      await setJobStatus(job.id, "failed", undefined, String(error));
      throw error;
    }
  }
} finally {
  try { await environment?.stop(); } finally { await pool.end(); }
}
