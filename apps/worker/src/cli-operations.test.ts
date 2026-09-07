import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,expect,it} from "vitest";
import {cleanCache,discoverLocal,explainResult,inspectCache} from "./cli-operations.js";

describe("standalone CLI operations",()=>{
  it("discovers configured local migrations without GitHub",async()=>{const root=await mkdtemp(join(tmpdir(),"dot75-discover-"));await mkdir(join(root,"db"));await writeFile(join(root,"db","V1__users.sql"),"CREATE TABLE users(id int);");const result=await discoverLocal(root,"version: 2\npostgres: {}\nmigrations: { directory: db, adapter: flyway }\n");expect(result).toMatchObject({adapter:"flyway",execution:"sql",ready:true});expect(result.migrations).toHaveLength(1);});
  it("inspects and selectively cleans JSON cache entries",async()=>{const root=await mkdtemp(join(tmpdir(),"dot75-cache-"));await writeFile(join(root,"one.json"),"{}");await writeFile(join(root,"keep.txt"),"keep");expect(await inspectCache(root)).toMatchObject({entries:1,bytes:2});expect(await cleanCache(root)).toMatchObject({removed:1});expect(await inspectCache(root)).toMatchObject({entries:0});});
  it("explains deterministic evidence without a model",()=>{const text=explainResult({jobId:"j",repository:"o/r",currentPr:1,baseSha:"a",headSha:"b",status:"failed",startedAt:"now",affectedObjects:[],dependencies:[],comparedPullRequests:[],orders:[{order:[1],passed:false,durationMs:1,findings:[{code:"42701",severity:"error",title:"Duplicate",message:"Column exists"}]}],contracts:[],rollbacks:[],performance:[]});expect(text).toContain("BLOCK o/r");expect(text).toContain("Next:");});
});
