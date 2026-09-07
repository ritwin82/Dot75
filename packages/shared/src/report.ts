import {findingCategory} from "./findings.js";
import type {Finding,ValidationResult} from "./types.js";

export type ReportFormat="json"|"human"|"markdown"|"sarif"|"junit";
const findings=(result:ValidationResult):Finding[]=>[...result.orders.flatMap((order)=>order.findings),...result.contracts,...result.rollbacks.flatMap((rollback)=>rollback.findings),...result.performance];
const xml=(value:unknown):string=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");

export function formatValidationResult(result:ValidationResult,format:ReportFormat):string {
  const all=findings(result);
  if(format==="json")return JSON.stringify(result,null,2);
  if(format==="human"){
    const lines=[`${result.status==="passed"?"PASS":"FAIL"} ${result.repository} PR #${result.currentPr}`,`Base ${result.baseSha.slice(0,12)} · Head ${result.headSha.slice(0,12)} · ${result.orders.length} order(s)`,`Compatibility: ${result.compatibility?.map((item)=>`#${item.pullRequests.join("/#")} ${item.status.replaceAll("_"," ")}`).join(", ")||"no peer relationships"}`];
    for(const finding of all)lines.push(`${finding.severity.toUpperCase()} ${finding.code} ${finding.title}${finding.file?` (${finding.file}${finding.line?`:${finding.line}`:""})`:""}\n  ${finding.message}`);
    lines.push(`Receipt ${result.provenance?.inputDigest??"unavailable"}`);return lines.join("\n");
  }
  if(format==="markdown"){
    const lines=[`# ${result.status==="passed"?"Passed":"Failed"}: ${result.repository} PR #${result.currentPr}`,"",`Base \`${result.baseSha}\` · Head \`${result.headSha}\``,"","## Execution orders","","| Order | Result | Duration |","| --- | --- | --- |",...result.orders.map((order)=>`| ${order.order.map((pr)=>`#${pr}`).join(" → ")} | ${order.passed?"Passed":"Failed"} | ${order.durationMs} ms |`),"","## Findings",""];
    if(!all.length)lines.push("No findings were recorded in the tested scope.");for(const finding of all)lines.push(`### ${finding.title} (\`${finding.code}\`)`,"",`${findingCategory(finding.code)} · ${finding.severity}`,"",finding.message,"");lines.push("## Reproduction receipt","",`\`${result.provenance?.inputDigest??"unavailable"}\``);return lines.join("\n");
  }
  if(format==="sarif")return JSON.stringify({version:"2.1.0",$schema:"https://json.schemastore.org/sarif-2.1.0.json",runs:[{tool:{driver:{name:"Dot75 LocalMesh",version:result.provenance?.engineVersion??"unknown",rules:[...new Map(all.map((finding)=>[finding.code,{id:finding.code,name:finding.title}])).values()]}},results:all.map((finding)=>({ruleId:finding.code,level:finding.severity==="error"?"error":finding.severity==="warning"?"warning":"note",message:{text:finding.message},...(finding.file?{locations:[{physicalLocation:{artifactLocation:{uri:finding.file},region:{startLine:finding.line??1}}}]}:{})}))}]},null,2);
  const failures=all.filter((finding)=>finding.severity==="error");return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="Dot75 migration compatibility" tests="${Math.max(1,result.orders.length)}" failures="${failures.length}">\n${result.orders.length?result.orders.map((order)=>`  <testcase name="${xml(order.order.map((pr)=>`PR ${pr}`).join(" then "))}" time="${order.durationMs/1000}">${order.passed?"":`\n    <failure message="Migration order failed">${xml(order.findings.map((finding)=>`${finding.code}: ${finding.message}`).join("\n"))}</failure>\n  `}</testcase>`).join("\n"):`  <testcase name="No migration execution"/>`}\n</testsuite>`;
}
