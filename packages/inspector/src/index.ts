import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { DependencyEdge, ObjectKind, SchemaObject, SchemaSnapshot } from "@localmesh/shared";

type CatalogRow = { kind: ObjectKind; schema_name: string | null; relation_name: string | null; object_name: string; definition: string };

const OBJECTS_SQL = `
WITH objects AS (
  SELECT CASE WHEN c.relispartition THEN 'partition' ELSE 'table' END::text kind, n.nspname schema_name, c.relname relation_name, c.relname object_name,
         concat(c.relpersistence, ':', c.relkind, '|rls=',c.relrowsecurity,'|force_rls=',c.relforcerowsecurity,'|replica_identity=',c.relreplident) definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
  UNION ALL
  SELECT 'column', n.nspname, c.relname, a.attname,
         concat(format_type(a.atttypid,a.atttypmod),'|nullable=',NOT a.attnotnull,'|default=',coalesce(pg_get_expr(d.adbin,d.adrelid),''),'|identity=',a.attidentity,'|generated=',a.attgenerated)
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL
  SELECT 'constraint', n.nspname, c.relname, con.conname, pg_get_constraintdef(con.oid,true)
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL
  SELECT 'index', n.nspname, t.relname, i.relname, pg_get_indexdef(i.oid)
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL
  SELECT CASE WHEN c.relkind='m' THEN 'materialized_view' ELSE 'view' END, n.nspname, c.relname, c.relname, pg_get_viewdef(c.oid,true)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.relkind IN ('v','m') AND n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL
  SELECT CASE WHEN p.prokind='p' THEN 'procedure' ELSE 'function' END, n.nspname, NULL, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL
  SELECT 'trigger', n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid,true)
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL
  SELECT 'policy', n.nspname, c.relname, p.polname,
         concat('cmd=',p.polcmd,'|roles=',p.polroles::text,'|using=',coalesce(pg_get_expr(p.polqual,p.polrelid),''),'|check=',coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''))
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  UNION ALL
  SELECT 'extension', NULL, NULL, extname, extversion FROM pg_extension WHERE extname <> 'plpgsql'
  UNION ALL
  SELECT 'enum', n.nspname, NULL, t.typname, string_agg(e.enumlabel,',' ORDER BY e.enumsortorder)
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
   WHERE n.nspname NOT IN ('pg_catalog','information_schema') GROUP BY n.nspname,t.typname
  UNION ALL
  SELECT 'sequence', n.nspname, NULL, c.relname, concat('persistence=',c.relpersistence)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL
  SELECT 'domain', n.nspname, NULL, t.typname, concat(format_type(t.typbasetype,t.typtypmod),'|not_null=',t.typnotnull,'|default=',coalesce(t.typdefault,''))
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
   WHERE t.typtype='d' AND n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL
  SELECT 'composite', n.nspname, NULL, t.typname, coalesce(pg_catalog.obj_description(t.oid,'pg_type'),'')
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
   WHERE t.typtype='c' AND t.typrelid=0 AND n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL
  SELECT 'collation', n.nspname, NULL, c.collname, concat(c.collprovider,'|',c.collcollate,'|',c.collctype)
    FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  UNION ALL
  SELECT 'publication', NULL, NULL, pubname, concat('insert=',pubinsert,'|update=',pubupdate,'|delete=',pubdelete,'|truncate=',pubtruncate,'|all_tables=',puballtables)
    FROM pg_publication
)
SELECT * FROM objects
 WHERE schema_name IS NULL OR (schema_name !~ '^pg_' AND schema_name <> 'information_schema')
 ORDER BY kind,schema_name,relation_name,object_name`;

const EDGES_SQL = `
SELECT 'column:'||ns.nspname||'.'||cl.relname||'.'||att.attname AS "from",
       'table:'||fns.nspname||'.'||fcl.relname AS "to", 'foreign_key' AS type
  FROM pg_constraint con JOIN pg_class cl ON cl.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace
  JOIN pg_class fcl ON fcl.oid=con.confrelid JOIN pg_namespace fns ON fns.oid=fcl.relnamespace
  JOIN LATERAL unnest(con.conkey) key(attnum) ON true JOIN pg_attribute att ON att.attrelid=cl.oid AND att.attnum=key.attnum
 WHERE con.contype='f'
UNION ALL
SELECT 'view:'||vn.nspname||'.'||v.relname, 'table:'||rn.nspname||'.'||r.relname, 'view_dependency'
  FROM pg_rewrite rw JOIN pg_class v ON v.oid=rw.ev_class JOIN pg_namespace vn ON vn.oid=v.relnamespace
  JOIN pg_depend d ON d.objid=rw.oid JOIN pg_class r ON r.oid=d.refobjid JOIN pg_namespace rn ON rn.oid=r.relnamespace
 WHERE v.relkind IN ('v','m') AND r.relkind IN ('r','p') AND vn.nspname NOT IN ('pg_catalog','information_schema')`;

function objectId(row: CatalogRow): string {
  const parts = [row.kind + ":", row.schema_name, row.relation_name !== row.object_name ? row.relation_name : null, row.object_name].filter(Boolean);
  return parts.join(".").replace(":.", ":");
}

export function fingerprintObjects(objects: SchemaObject[]): string {
  const normalized = objects.map(({ id, definition }) => JSON.stringify([id, definition])).sort().join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}

export async function inspectSchema(client: PoolClient): Promise<SchemaSnapshot> {
  const [objectResult, edgeResult] = await Promise.all([client.query<CatalogRow>(OBJECTS_SQL), client.query<DependencyEdge>(EDGES_SQL)]);
  const objects = objectResult.rows.map((row) => ({
    id: objectId(row), kind: row.kind, name: row.object_name, definition: row.definition,
    ...(row.schema_name ? { schema: row.schema_name } : {}), ...(row.relation_name ? { relation: row.relation_name } : {})
  }));
  const edges = edgeResult.rows.sort((a,b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`));
  return { objects, edges, fingerprint: fingerprintObjects(objects) };
}

export function diffObjects(before: SchemaSnapshot, after: SchemaSnapshot): SchemaObject[] {
  const old = new Map(before.objects.map((o) => [o.id, o.definition]));
  const changed = after.objects.filter((o) => old.get(o.id) !== o.definition);
  const now = new Set(after.objects.map((o) => o.id));
  for (const removed of before.objects.filter((o) => !now.has(o.id))) changed.push({ ...removed, definition: `<removed>${removed.definition}` });
  return changed.sort((a,b) => a.id.localeCompare(b.id));
}

export function relationKey(object: SchemaObject): string {
  return object.relation && object.schema ? `${object.schema}.${object.relation}` : object.id;
}
