import type { CompatibilityRelationship, ValidationResult } from "./types.js";

const sameOrder = (a: number[], b: number[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);

/** Derive pair classifications exclusively from recorded engine evidence. */
export function deriveCompatibilityRelationships(result: ValidationResult): CompatibilityRelationship[] {
  const currentSingle = result.orders.find((order) => sameOrder(order.order, [result.currentPr]));
  return (result.scope?.decisions ?? []).map((decision) => {
    const pair: [number, number] = [result.currentPr, decision.pr];
    if (decision.decision === "skipped") return {
      pullRequests: pair, status: "independent", testedOrders: [], findingCodes: [], reason: decision.reason
    };
    const candidateSingle = result.orders.find((order) => sameOrder(order.order, [decision.pr]));
    const combined = result.orders.filter((order) => order.order.length === 2 && order.order.includes(result.currentPr) && order.order.includes(decision.pr));
    const findingCodes = [...new Set(combined.flatMap((order) => order.findings.map((finding) => finding.code)))];
    if (!currentSingle || !candidateSingle || combined.length !== 2) return {
      pullRequests: pair, status: "untested", testedOrders: combined.map((order) => order.order), findingCodes,
      reason: "The stored result does not contain every standalone and pair order required for a compatibility conclusion."
    };
    if (!currentSingle.passed || !candidateSingle.passed) return {
      pullRequests: pair, status: "standalone_invalid", testedOrders: combined.map((order) => order.order), findingCodes,
      reason: "At least one pull request failed alone, so pair compatibility cannot be established."
    };
    const passing = combined.filter((order) => order.passed);
    if (passing.length === 2) return {
      pullRequests: pair, status: "compatible", testedOrders: combined.map((order) => order.order), findingCodes,
      reason: "Both tested application orders passed."
    };
    if (passing.length === 1) return {
      pullRequests: pair, status: "order_sensitive", testedOrders: combined.map((order) => order.order), passingOrder: passing[0]!.order,
      findingCodes, reason: `Only ${passing[0]!.order.map((pr) => `#${pr}`).join(" → ")} passed.`
    };
    return {
      pullRequests: pair, status: "conflict", testedOrders: combined.map((order) => order.order), findingCodes,
      reason: "Both pull requests passed alone, but neither combined application order passed."
    };
  });
}
