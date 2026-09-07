import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresValidationEnvironment } from "@localmesh/engine";
import type { ValidationJob } from "@localmesh/shared";
import { demoScenarios } from "./demo-scenarios.js";
import { resultFindings, runValidationPlan } from "./validation-plan.js";

describe.skipIf(process.env.RUN_DOCKER_TESTS !== "1")("shared PR validation plan", () => {
  let environment: PostgresValidationEnvironment;
  beforeAll(async () => { environment = await PostgresValidationEnvironment.start("16"); });
  afterAll(async () => { await environment?.stop(); });
  const job = (pr: number): ValidationJob => ({ id: "integration", installationId: 0, owner: "test", repo: "test", prNumber: pr, headSha: "head", baseSha: "base" });
  for (const scenario of demoScenarios) it(scenario.name, async () => {
    const result = await runValidationPlan(environment, job(scenario.plan.current.pr), scenario.plan);
    expect(result.status, JSON.stringify(resultFindings(result))).toBe(scenario.expectedPassed ? "passed" : "failed");
    if (scenario.expectedCode) expect(resultFindings(result).map((finding) => finding.code)).toContain(scenario.expectedCode);
    if (scenario.singlesPass) expect(result.orders.filter((order) => order.order.length === 1).every((order) => order.passed)).toBe(true);
    if (scenario.name === "inventory-contract-collision") {
      expect(result.orders.filter((order) => order.order.length === 2)).toHaveLength(2);
      expect(result.orders.every((order) => order.sqlPassed && order.contractsChecked)).toBe(true);
      expect(result.orders.filter((order) => order.order.length === 2).every((order) => !order.passed)).toBe(true);
    }
    if (scenario.expectedPassed) expect(result.scope?.skippedPrs).toEqual([213]);
    expect(result.orders.every((order) => !order.snapshot)).toBe(true);
    expect(result.affectedObjects.every((object) => !object.schema?.startsWith("pg_"))).toBe(true);
  });
  it("does not silently pass required contracts without mappings or fixtures", async () => {
    const plan = { ...demoScenarios[0]!.plan, candidates: [], requireDataContracts: true };
    const result = await runValidationPlan(environment, job(plan.current.pr), plan);
    expect(result.status).toBe("failed");
    expect(result.contracts.map((finding) => finding.code)).toEqual(["CONTRACT_BINDING_MISSING", "FIXTURES_REQUIRED"]);
  });
  it("keeps working after invalid baseline SQL", async () => {
    const scenario = demoScenarios[0]!;
    await expect(environment.executeOrder([{ path: "bad.up.sql", sql: "INVALID SQL", direction: "up", order: 0 }], [], [])).rejects.toThrow();
    expect((await environment.executeOrder(scenario.plan.baseline, [scenario.plan.current], [])).passed).toBe(true);
  });
  it("replays earlier data migrations before checking the next rollback", async () => {
    const baseline = [{ path: "001.up.sql", sql: "CREATE TABLE stock(id int, quantity int);", direction: "up" as const, order: 1 }];
    const prior = [{ path: "002.up.sql", sql: "UPDATE stock SET quantity = quantity - 6;", direction: "up" as const, order: 2 }];
    const up = { path: "003.up.sql", sql: "UPDATE stock SET quantity = 1;", direction: "up" as const, order: 3 };
    const down = { path: "003.down.sql", sql: "UPDATE stock SET quantity = 4;", direction: "down" as const, order: 3 };
    const result = await environment.verifyRollback(baseline, up, down, [], ["INSERT INTO stock VALUES (1,10);"], prior);
    expect(result.dataRestored).toBe(true);
    expect(result.status).toBe("safe");
  });
});
