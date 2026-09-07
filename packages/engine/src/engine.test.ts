import { describe,expect,it } from "vitest";
import { analyzePerformance, areRelated, dataStateDifferences, destructiveStatements } from "./index.js";
const obj=(id:string,relation:string)=>({id,kind:"column" as const,schema:"public",relation,name:id,definition:"x"});
describe("collision selection",()=>{
  it("relates changes on the same table",()=>expect(areRelated({pr:1,objects:[obj("a","orders")],edges:[]},{pr:2,objects:[obj("b","orders")],edges:[]})).toBe(true));
  it("skips unrelated tables",()=>expect(areRelated({pr:1,objects:[obj("a","orders")],edges:[]},{pr:2,objects:[obj("b","users")],edges:[]})).toBe(false));
  it("tests data-only migrations without catalog changes",()=>expect(areRelated({pr:1,objects:[],edges:[]},{pr:2,objects:[obj("b","users")],edges:[]})).toBe(true));
});
describe("risk analysis",()=>{
  const file={path:"1.up.sql",sql:"CREATE INDEX idx ON orders(id);",direction:"up" as const,order:1};
  it("flags blocking indexes",()=>expect(analyzePerformance([file]).some((f)=>f.code==="NON_CONCURRENT_INDEX")).toBe(true));
  it("flags destructive rollback risk",()=>expect(destructiveStatements({...file,sql:"DROP TABLE orders"})[0]?.code).toBe("DROP_TABLE"));
  it("flags unsafe rollout and transaction patterns",()=>{
    const findings=analyzePerformance([{...file,sql:"BEGIN; CREATE INDEX CONCURRENTLY idx ON orders(id); ALTER TABLE orders ADD COLUMN state text NOT NULL DEFAULT now(); UPDATE orders SET state='x';"}]);
    expect(findings.map((finding)=>finding.code)).toEqual(expect.arrayContaining(["CONCURRENT_INDEX_TRANSACTION","UNSAFE_NOT_NULL","VOLATILE_DEFAULT","UNBOUNDED_BACKFILL"]));
  });
});
describe("fixture-state comparison",()=>it("reports only changed table fingerprints",()=>{
  const first={fingerprint:"a",tables:[{table:"public.orders",rowCount:1,fingerprint:"one"},{table:"public.users",rowCount:1,fingerprint:"same"}],sequences:[{sequence:"public.orders_id_seq",lastValue:"1",isCalled:true}]};
  const second={fingerprint:"b",tables:[{table:"public.orders",rowCount:2,fingerprint:"two"},{table:"public.users",rowCount:1,fingerprint:"same"}],sequences:[{sequence:"public.orders_id_seq",lastValue:"2",isCalled:true}]};
  expect(dataStateDifferences(first,second)).toEqual([{table:"public.orders",first:first.tables[0],second:second.tables[0]},{table:"sequence:public.orders_id_seq",first:{table:"sequence:public.orders_id_seq",rowCount:1,fingerprint:"1",sampleRows:[{lastValue:"1",isCalled:true}]},second:{table:"sequence:public.orders_id_seq",rowCount:1,fingerprint:"2",sampleRows:[{lastValue:"2",isCalled:true}]}}]);
}));
