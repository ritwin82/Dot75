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
      const unsafeNotNull = sql.match(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w."-]+)[\s\S]*(?:ADD\s+COLUMN[\s\S]*NOT\s+NULL|ALTER\s+COLUMN[\s\S]*SET\s+NOT\s+NULL)/i);
      const volatileDefault = /DEFAULT\s+(?:now\s*\(|clock_timestamp\s*\(|random\s*\(|gen_random_uuid\s*\()/i.test(sql);
      const unboundedBackfill = /\b(?:UPDATE|DELETE\s+FROM)\b(?![^;]*\bWHERE\b)[^;]*(?:;|$)/i.test(sql);
      const concurrentInTransaction = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(sql) && /\b(?:BEGIN|START\s+TRANSACTION)\b/i.test(file.sql);
      const replacesRoutine = /CREATE\s+OR\s+REPLACE\s+(?:FUNCTION|PROCEDURE|TRIGGER)\b/i.test(sql);
      const relation = (addDefault?.[1] ?? typeChange?.[1] ?? "").replaceAll('"',"").toLowerCase();
      if ((addDefault || typeChange) && large.has(relation)) findings.push({
        code: "POTENTIAL_TABLE_REWRITE", severity: "warning", title: "Large table may be rewritten",
        message: `${relation} is large and this ALTER TABLE may rewrite it or hold a long lock.`, file: file.path,
        evidence: { relation, metadata: large.get(relation) }
      });
      if (index) findings.push({ code:"NON_CONCURRENT_INDEX", severity:"warning", title:"Index creation may block writes", message:"Use CREATE INDEX CONCURRENTLY when the migration framework permits it.", file:file.path });
      if (constraint) findings.push({ code:"EAGER_CONSTRAINT_VALIDATION", severity:"warning", title:"Constraint validation may hold a lock", message:"Consider ADD CONSTRAINT ... NOT VALID followed by VALIDATE CONSTRAINT.", file:file.path });
      if (unsafeNotNull) findings.push({code:"UNSAFE_NOT_NULL",severity:"warning",title:"NOT NULL rollout may block or fail",message:"Backfill and validate existing rows before enforcing NOT NULL in a later migration.",file:file.path,evidence:{relation:unsafeNotNull[1]?.replaceAll('"','').toLowerCase()}});
      if (volatileDefault) findings.push({code:"VOLATILE_DEFAULT",severity:"warning",title:"Volatile default changes row state",message:"Evaluate generated values explicitly; repeated executions or table rewrites may produce different data.",file:file.path});
      if (unboundedBackfill) findings.push({code:"UNBOUNDED_BACKFILL",severity:"warning",title:"Data change has no WHERE guard",message:"Batch large updates or deletes and add an explicit predicate before running against a populated table.",file:file.path});
      if (concurrentInTransaction) findings.push({code:"CONCURRENT_INDEX_TRANSACTION",severity:"error",title:"Concurrent index cannot run in a transaction",message:"Run CREATE INDEX CONCURRENTLY outside an explicit transaction.",file:file.path});
      if (replacesRoutine) findings.push({code:"ROUTINE_REPLACEMENT",severity:"warning",title:"Database behavior is being replaced",message:"Review dependent triggers, views, and callers when replacing a function, procedure, or trigger.",file:file.path});
    }
    if(file.sql.split(";").filter((statement)=>statement.trim()).length>25)findings.push({code:"LONG_MIGRATION_TRANSACTION",severity:"warning",title:"Migration contains many statements",message:"Split large migrations into observable, restartable stages to reduce lock duration and recovery risk.",file:file.path});
  }
  return findings;
}

export function destructiveStatements(file: MigrationFile): Finding[] {
  const rules = [
    { re:/\bDROP\s+TABLE\b/i, code:"DROP_TABLE", message:"Dropping a table destroys its records." },
    { re:/\bDROP\s+COLUMN\b/i, code:"DROP_COLUMN", message:"Dropping a column destroys its values." },
    { re:/\bALTER\s+TYPE\b[\s\S]*\bRENAME\s+VALUE\b/i, code:"ENUM_VALUE_CHANGE", message:"Enum value changes may not be reversible for stored rows." },
    { re:/\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i, code:"TYPE_CONVERSION", message:"Column type conversions may lose precision or fail to reverse." },
    { re:/\bTRUNCATE\b/i, code:"TRUNCATE_TABLE", message:"Truncating a table destroys all of its rows." },
    { re:/\bDROP\s+TYPE\b/i, code:"DROP_TYPE", message:"Dropping a type can invalidate dependent objects and stored values." }
  ];
  return rules.filter((r) => r.re.test(file.sql)).map((r) => ({ code:r.code, severity:"warning", title:"Potentially destructive migration", message:r.message, file:file.path }));
}
