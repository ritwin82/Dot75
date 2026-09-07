import type { DependencyEdge, SchemaObject } from "@localmesh/shared";
import { relationKey } from "@localmesh/inspector";

export interface ChangeSet { pr: number; objects: SchemaObject[]; edges: DependencyEdge[] }

export function areRelated(a: ChangeSet, b: ChangeSet): boolean {
  // An empty catalog diff can be a data migration. Absence of schema evidence
  // is not proof that its reads/writes are independent of another PR.
  if (!a.objects.length || !b.objects.length) return true;
  const aIds = new Set(a.objects.flatMap((o) => [o.id, relationKey(o)]));
  const bIds = new Set(b.objects.flatMap((o) => [o.id, relationKey(o)]));
  if ([...aIds].some((id) => bIds.has(id))) return true;
  const edges = [...a.edges, ...b.edges];
  return edges.some((edge) =>
    (aIds.has(edge.from) && bIds.has(edge.to)) || (bIds.has(edge.from) && aIds.has(edge.to))
  );
}

export function selectRelated(current: ChangeSet, candidates: ChangeSet[]): ChangeSet[] {
  return candidates.filter((candidate) => areRelated(current, candidate));
}
