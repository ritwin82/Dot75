import {describe,expect,it} from "vitest";
import {parseMappings,suggestMappings,validateSchemaContracts} from "./index.js";
const objects=[{id:"table:public.sales_order",kind:"table" as const,schema:"public",relation:"sales_order",name:"sales_order",definition:"r"},{id:"column:public.sales_order.id",kind:"column" as const,schema:"public",relation:"sales_order",name:"id",definition:"uuid"}];
describe("contracts",()=>{
  it("suggests semantic templates",()=>expect(suggestMappings(objects)[0]?.template).toBe("orders"));
  it("reports missing bound columns",()=>expect(validateSchemaContracts(objects,{version:1,mappings:[{template:"orders",bindings:{table:"public.sales_order",id:"id",customer_id:"user_id",status:"state"},enabled:true}]}).filter((f)=>f.code==="CONTRACT_COLUMN_MISSING")).toHaveLength(2));
  it("supports custom schema contracts and rejects mutating SQL",()=>{
    const findings=validateSchemaContracts(objects,{version:2,mappings:[],schema_assertions:[{id:"orders-table",name:"Orders table",object:"table:public.orders",exists:true,severity:"error"}],sql_assertions:[]});
    expect(findings[0]?.code).toBe("CUSTOM_SCHEMA_CONTRACT_FAILED");
    expect(()=>parseMappings("version: 2\nsql_assertions:\n  - id: unsafe\n    name: Unsafe\n    sql: DELETE FROM users\n    expect: { type: zero_rows }\n")).toThrow();
  });
});
