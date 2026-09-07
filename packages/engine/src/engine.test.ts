import { describe,expect,it } from "vitest";
import { analyzePerformance, areRelated, destructiveStatements } from "./index.js";
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
});
