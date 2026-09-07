import{describe,expect,it}from"vitest";
import{defaultConfig}from"@localmesh/shared";
import{applyRemediationCandidate}from"./remediation.js";
import type{ValidationInput}from"./input.js";
const input:ValidationInput={version:1,job:{id:"j",installationId:0,owner:"o",repo:"r",prNumber:1,headSha:"a".repeat(40),baseSha:"b".repeat(40)},config:defaultConfig,baseline:[],current:{pr:1,files:[{path:"db/1.up.sql",sql:"SELECT 1",direction:"up",order:1}]},candidates:[],fixtures:[],provenance:{pullRequests:[{number:1,author:"a",headSha:"a".repeat(40)}],currentPrFiles:["db/1.up.sql"],inputDigest:"c".repeat(64)}};
describe("verified remediation input",()=>{
  it("replaces only current PR SQL and invalidates the old receipt",()=>{const changed=applyRemediationCandidate(input,{patches:[{path:"db/1.up.sql",sql:"SELECT 2"}]});expect(changed.current.files[0]?.sql).toBe("SELECT 2");expect(changed.provenance?.inputDigest).toBeUndefined();});
  it("rejects unknown and duplicate paths",()=>{expect(()=>applyRemediationCandidate(input,{patches:[{path:"db/other.up.sql",sql:"SELECT 2"}]})).toThrow("only replace");expect(()=>applyRemediationCandidate(input,{patches:[{path:"db/1.up.sql",sql:"SELECT 2"},{path:"db/1.up.sql",sql:"SELECT 3"}]})).toThrow("duplicate");});
});
