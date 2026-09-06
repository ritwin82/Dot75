import {describe,expect,it} from "vitest";
import {suggestMappings,validateSchemaContracts} from "./index.js";
const objects=[{id:"table:public.sales_order",kind:"table" as const,schema:"public",relation:"sales_order",name:"sales_order",definition:"r"},{id:"column:public.sales_order.id",kind:"column" as const,schema:"public",relation:"sales_order",name:"id",definition:"uuid"}];
describe("contracts",()=>{
  it("suggests semantic templates",()=>expect(suggestMappings(objects)[0]?.template).toBe("orders"));
  it("reports missing bound columns",()=>expect(validateSchemaContracts(objects,{version:1,mappings:[{template:"orders",bindings:{table:"public.sales_order",id:"id",customer_id:"user_id",status:"state"},enabled:true}]}).filter((f)=>f.code==="CONTRACT_COLUMN_MISSING")).toHaveLength(2));
});
