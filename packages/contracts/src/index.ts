import yaml from "js-yaml";
import { z } from "zod";
import type { Pool } from "pg";
import type { Finding, SchemaObject } from "@localmesh/shared";

const templateNames = ["users","orders","payments","inventory","soft-deletion","multi-tenancy"] as const;
export type TemplateName = typeof templateNames[number];

const mappingSchema = z.object({
  version:z.literal(1),
  mappings:z.array(z.object({ template:z.enum(templateNames), bindings:z.record(z.string(),z.string().min(1)), enabled:z.boolean().default(true) }))
});
export type ContractMappings=z.infer<typeof mappingSchema>;
export const parseMappings=(source:string):ContractMappings=>mappingSchema.parse(yaml.load(source));

interface Template { required:string[]; dataCheck?:(b:Record<string,string>)=>string }
const q=(id:string)=>id.split(".").map((p)=>`"${p.replaceAll('"','""')}"`).join(".");

export const templates:Record<TemplateName,Template>={
  users:{required:["table","id","identity","created_at"]},
  orders:{required:["table","id","customer_id","status"]},
  payments:{required:["table","id","order_id","amount","currency"],dataCheck:(b)=>`SELECT count(*)::int failures FROM ${q(b.table!)} WHERE ${q(b.amount!)} < 0 OR ${q(b.currency!)} IS NULL`},
  inventory:{required:["table","product_id","quantity"],dataCheck:(b)=>`SELECT count(*)::int failures FROM ${q(b.table!)} WHERE ${q(b.quantity!)} < 0`},
  "soft-deletion":{required:["table","deleted_at"]},
  "multi-tenancy":{required:["table","tenant_id","tenant_table"]}
};

function splitTable(value:string):[string,string] { const parts=value.split("."); return parts.length===1?["public",parts[0]!] : [parts[0]!,parts[1]!]; }

export function validateSchemaContracts(objects:SchemaObject[],config:ContractMappings):Finding[] {
  const findings:Finding[]=[]; const ids=new Set(objects.map((o)=>o.id));
  for(const mapping of config.mappings.filter((m)=>m.enabled)) {
    const template=templates[mapping.template];
    for(const key of template.required) if(!mapping.bindings[key]) findings.push({code:"CONTRACT_BINDING_MISSING",severity:"error",title:"Contract mapping is incomplete",message:`${mapping.template} requires a ${key} binding.`,evidence:{template:mapping.template,binding:key}});
    const table=mapping.bindings.table; if(!table) continue; const [schema,relation]=splitTable(table);
    if(!ids.has(`table:${schema}.${relation}`)) findings.push({code:"CONTRACT_TABLE_MISSING",severity:"error",title:"Required table is missing",message:`${mapping.template} expects ${schema}.${relation}.`,evidence:{template:mapping.template,objects:[`table:${schema}.${relation}`]}});
    for(const [key,column] of Object.entries(mapping.bindings)) {
      if(key==="table"||key.endsWith("_table")) continue;
      const id=`column:${schema}.${relation}.${column}`;
      if(!ids.has(id)) findings.push({code:"CONTRACT_COLUMN_MISSING",severity:"error",title:"Required column is missing",message:`${mapping.template}.${key} expects ${schema}.${relation}.${column}.`,evidence:{template:mapping.template,objects:[id]}});
    }
    if(mapping.template==="multi-tenancy") {
      const hasPolicy=objects.some((o)=>o.kind==="policy"&&o.schema===schema&&o.relation===relation);
      if(!hasPolicy) findings.push({code:"RLS_POLICY_MISSING",severity:"error",title:"Tenant isolation policy is missing",message:`${schema}.${relation} has no row-level security policy.`,evidence:{objects:[`table:${schema}.${relation}`]}});
    }
  }
  return findings;
}

export async function runDataContracts(pool:Pool,config:ContractMappings):Promise<Finding[]> {
  const findings:Finding[]=[];
  for(const mapping of config.mappings.filter((m)=>m.enabled)) {
    const sql=templates[mapping.template].dataCheck?.(mapping.bindings); if(!sql) continue;
    try { const {rows}=await pool.query<{failures:number}>(sql); if((rows[0]?.failures??0)>0) findings.push({code:"DATA_CONTRACT_FAILED",severity:"error",title:"Fixture data violates a contract",message:`${mapping.template} found ${rows[0]!.failures} invalid row(s).`,evidence:{template:mapping.template}}); }
    catch(error) { findings.push({code:"DATA_CONTRACT_ERROR",severity:"error",title:"Data contract could not run",message:error instanceof Error?error.message:String(error),evidence:{template:mapping.template}}); }
  }
  return findings;
}

const concepts:Record<TemplateName,string[]>={users:["user","users","account","member"],orders:["order","orders","sales_order"],payments:["payment","payments","transaction"],inventory:["inventory","stock"],"soft-deletion":["deleted_at","archived_at"],"multi-tenancy":["tenant_id","organization_id","workspace_id"]};
export function suggestMappings(objects:SchemaObject[]):Array<{template:TemplateName;table:string;confidence:number}> {
  const tables=objects.filter((o)=>o.kind==="table"); const suggestions:Array<{template:TemplateName;table:string;confidence:number}>=[];
  for(const name of templateNames) for(const table of tables) {
    const haystack=`${table.name} ${objects.filter((o)=>o.relation===table.name).map((o)=>o.name).join(" ")}`.toLowerCase();
    const hits=concepts[name].filter((term)=>haystack.includes(term)).length;
    if(hits) suggestions.push({template:name,table:`${table.schema}.${table.name}`,confidence:Math.min(.95,.55+hits*.15)});
  }
  return suggestions.sort((a,b)=>b.confidence-a.confidence);
}
