import { deriveCompatibilityRelationships, type CompatibilityGraphSnapshot, type CompatibilityNode, type CompatibilityRelationship, type ValidationResult } from "@localmesh/shared";

export interface CompatibilityJob {
  id: string;
  status: string;
  createdAt: string;
  result?: ValidationResult;
}

const singleStatus = (result: ValidationResult, pr: number): CompatibilityNode["standalone"] => {
  const order = result.orders.find((item) => item.order.length === 1 && item.order[0] === pr);
  return order ? order.passed ? "passed" : "failed" : "unknown";
};

export function buildCompatibilityGraph(repository: string, jobs: CompatibilityJob[]): CompatibilityGraphSnapshot | null {
  const completed = jobs.filter((job) => job.result && ["passed", "failed", "cancelled"].includes(job.status))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const latest = completed[0];
  if (!latest?.result) return null;
  const baseSha = latest.result.baseSha;
  const sameBase = completed.filter((job) => job.result?.baseSha === baseSha);
  const nodes = new Map<number, CompatibilityNode>();
  for (const job of sameBase) {
    const result = job.result!;
    const refs = result.provenance?.pullRequests ?? [];
    for (const ref of refs) {
      if (ref.number === 0 || nodes.has(ref.number)) continue;
      nodes.set(ref.number, { pr: ref.number, ...(ref.title ? { title: ref.title } : {}), author: ref.author, headSha: ref.headSha, standalone: singleStatus(result, ref.number) });
    }
    if (result.currentPr > 0 && !nodes.has(result.currentPr)) nodes.set(result.currentPr, {
      pr: result.currentPr, headSha: result.headSha, standalone: singleStatus(result, result.currentPr)
    });
  }
  // Improve unknown node status from any matching immutable observation.
  for (const job of sameBase) for (const node of nodes.values()) {
    if (node.standalone !== "unknown") continue;
    const ref = job.result?.provenance?.pullRequests.find((item) => item.number === node.pr);
    if (ref && ref.headSha === node.headSha) node.standalone = singleStatus(job.result!, node.pr);
  }
  const edges = new Map<string, CompatibilityRelationship>();
  for (const job of sameBase) {
    const result = job.result!;
    for (const relationship of result.compatibility ?? deriveCompatibilityRelationships(result)) {
      const [a, b] = relationship.pullRequests;
      const left = nodes.get(a); const right = nodes.get(b);
      if (!left || !right) continue;
      const refs = result.provenance?.pullRequests ?? [];
      const leftRef = refs.find((ref) => ref.number === a); const rightRef = refs.find((ref) => ref.number === b);
      if ((left.headSha && leftRef?.headSha !== left.headSha) || (right.headSha && rightRef?.headSha !== right.headSha)) continue;
      const key = [a, b].sort((x, y) => x - y).join(":");
      if (!edges.has(key)) edges.set(key, { ...relationship, pullRequests: [Math.min(a, b), Math.max(a, b)], sourceJobId: job.id, observedAt: job.createdAt });
    }
  }
  const nodeList = [...nodes.values()].sort((a, b) => a.pr - b.pr);
  const edgeList = [...edges.values()].sort((a, b) => a.pullRequests[0] - b.pullRequests[0] || a.pullRequests[1] - b.pullRequests[1]);
  const possiblePairs = nodeList.length * (nodeList.length - 1) / 2;
  const classifiedPairs = edgeList.filter((edge) => edge.status !== "untested").length;
  return {
    repository, baseSha, generatedAt: latest.createdAt, nodes: nodeList, edges: edgeList,
    coverage: { possiblePairs, classifiedPairs, missingPairs: Math.max(0, possiblePairs - classifiedPairs) }
  };
}
