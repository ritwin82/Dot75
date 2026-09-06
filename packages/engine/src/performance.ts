import type { Finding, MigrationFile } from "@localmesh/shared";

export interface RelationMetadata { relation: string; estimatedRows?: number|undefined; bytes?: number|undefined; indexes?: string[]|undefined }

export function analyzePerformance(files: MigrationFile[], metadata: RelationMetadata[] = []): Finding[] {
  const findings: Finding[] = [];
  const large = new Map(metadata.filter((m) => (m.estimatedRows ?? 0) > 100_000 || (m.bytes ?? 0) > 1_000_000_000).map((m) => [m.relation.toLowerCase(), m]));
  for (const file of files.filter((f) => f.direction === "up")) {
    const statements = file.sql.split(/;\s*(?:\r?\n|$)/);
    for (const statement of statements) {
      const sql = statement.trim();
      const addDefault = sql.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w."-]+)[\s\S]*ADD\s+COLUMN[\s\S]*DEFAULT/i);
      const typeChange = sql.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w."-]+)[\s\S]*ALTER\s+COLUMN[\s\S]*TYPE/i);
      const index = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)/i);
      const constraint = sql.match(/ALTER\s+TABLE[\s\S]*ADD\s+CONSTRAINT(?![\s\S]*NOT\s+VALID)/i);
      const relation = (addDefault?.[1] ?? typeChange?.[1] ?? "").replaceAll('"',"").toLowerCase();
      if ((addDefault || typeChange) && large.has(relation)) findings.push({
        code: "POTENTIAL_TABLE_REWRITE", severity: "warning", title: "Large table may be rewritten",
        message: `${relation} is large and this ALTER TABLE may rewrite it or hold a long lock.`, file: file.path,
        evidence: { relation, metadata: large.get(relation) }
      });
      if (index) findings.push({ code:"NON_CONCURRENT_INDEX", severity:"warning", title:"Index creation may block writes", message:"Use CREATE INDEX CONCURRENTLY when the migration framework permits it.", file:file.path });
      if (constraint) findings.push({ code:"EAGER_CONSTRAINT_VALIDATION", severity:"warning", title:"Constraint validation may hold a lock", message:"Consider ADD CONSTRAINT ... NOT VALID followed by VALIDATE CONSTRAINT.", file:file.path });
    }
  }
  return findings;
}

export function destructiveStatements(file: MigrationFile): Finding[] {
  const rules = [
    { re:/\bDROP\s+TABLE\b/i, code:"DROP_TABLE", message:"Dropping a table destroys its records." },
    { re:/\bDROP\s+COLUMN\b/i, code:"DROP_COLUMN", message:"Dropping a column destroys its values." },
    { re:/\bALTER\s+TYPE\b[\s\S]*\bRENAME\s+VALUE\b/i, code:"ENUM_VALUE_CHANGE", message:"Enum value changes may not be reversible for stored rows." },
    { re:/\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i, code:"TYPE_CONVERSION", message:"Column type conversions may lose precision or fail to reverse." }
  ];
  return rules.filter((r) => r.re.test(file.sql)).map((r) => ({ code:r.code, severity:"warning", title:"Potentially destructive migration", message:r.message, file:file.path }));
}
