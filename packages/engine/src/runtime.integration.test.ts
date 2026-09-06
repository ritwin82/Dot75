import {describe,expect,it} from "vitest";
import {PostgresValidationEnvironment} from "./runtime.js";
const enabled=process.env.RUN_DOCKER_TESTS==="1";
describe.skipIf(!enabled)("PostgreSQL validation environment",()=>{
  it("detects a two-PR collision and an incomplete rollback",async()=>{const env=await PostgresValidationEnvironment.start("16");try{const base=[{path:"001.up.sql",sql:"CREATE TABLE orders(id bigint PRIMARY KEY);",direction:"up" as const,order:1}],a=[{path:"002.up.sql",sql:"ALTER TABLE orders ADD COLUMN status text;",direction:"up" as const,order:2}],b=[{path:"003.up.sql",sql:"ALTER TABLE orders ADD COLUMN status integer;",direction:"up" as const,order:3}];const order=await env.executeOrder(base,[{pr:1,files:a},{pr:2,files:b}],[]);expect(order.passed).toBe(false);const rollback=await env.verifyRollback(base,a[0]!,{path:"002.down.sql",sql:"SELECT 1",direction:"down",order:2},[]);expect(rollback.status).toBe("unsafe");}finally{await env.stop();}});
});
