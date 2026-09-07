import {describe,expect,it} from "vitest";
import {buildRecurrenceSnapshot} from "./recurrence.js";
import type {ValidationResult} from "@localmesh/shared";
const base:ValidationResult={jobId:"j",repository:"o/r",currentPr:1,baseSha:"a".repeat(40),headSha:"b".repeat(40),status:"failed",startedAt:"now",affectedObjects:[],dependencies:[],comparedPullRequests:[],orders:[{order:[1],passed:false,durationMs:1,findings:[{code:"42701",severity:"error",title:"Duplicate",message:"first",evidence:{objects:["column:public.t.c"]}}]}],contracts:[],rollbacks:[],performance:[]};
describe("recurrence history",()=>it("groups stable findings across changing messages",()=>{
  const later={...base,jobId:"j2",orders:[{...base.orders[0]!,findings:[{...base.orders[0]!.findings[0]!,message:"second"}]}]};
  const snapshot=buildRecurrenceSnapshot("o/r",[{id:"j1",status:"failed",createdAt:"2026-01-01T00:00:00Z",result:base},{id:"j2",status:"failed",createdAt:"2026-01-02T00:00:00Z",result:later}]);
  expect(snapshot.findings[0]).toMatchObject({count:2,active:true,pullRequests:[1]});
}));
