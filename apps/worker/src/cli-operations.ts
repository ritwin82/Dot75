import {lstat,readdir,readFile,unlink} from "node:fs/promises";
import {relative,resolve,sep} from "node:path";
import {migrationAdapters,migrationFilesFromSource} from "@localmesh/github";
import {findingGuidance,parseConfig,uniqueFindings,type ValidationResult} from "@localmesh/shared";

async function filesBelow(directory:string,limit=50_000):Promise<string[]> {
  const pending=[directory];const files:string[]=[];
  while(pending.length){const current=pending.pop()!;for(const entry of await readdir(current,{withFileTypes:true})){const path=resolve(current,entry.name);if(entry.isDirectory())pending.push(path);else if(entry.isFile())files.push(path);if(files.length>limit)throw new Error(`Discovery exceeds the ${limit} file safety limit.`);}}
  return files;
}

export async function discoverLocal(root:string,configSource:string):Promise<Record<string,unknown>> {
  const config=parseConfig(configSource);const repositoryRoot=resolve(root);const migrationRoot=resolve(repositoryRoot,config.migrations.directory);
  if(migrationRoot!==repositoryRoot&&!migrationRoot.startsWith(`${repositoryRoot}${sep}`))throw new Error("The configured migration root escapes the repository root.");
  const definition=migrationAdapters[config.migrations.adapter];const discovered=[];const unsupported:string[]=[];
  for(const path of await filesBelow(migrationRoot)){
    const repositoryPath=relative(repositoryRoot,path).replaceAll("\\","/");if(!definition.extensions.some((extension)=>repositoryPath.endsWith(extension)))continue;
    const source=await readFile(path,"utf8");const migrations=migrationFilesFromSource(repositoryPath,source,config.migrations.adapter);
    if(migrations.length)discovered.push(...migrations.map(({sql,...migration})=>({...migration,bytes:Buffer.byteLength(sql)})));else unsupported.push(repositoryPath);
  }
  return {version:1,adapter:config.migrations.adapter,execution:definition.execution,migrationRoot:relative(repositoryRoot,migrationRoot).replaceAll("\\","/"),migrations:discovered,unsupported,ready:unsupported.length===0};
}

export function explainResult(result:ValidationResult,format:"human"|"markdown"="human"):string {
  const findings=uniqueFindings([...result.orders.flatMap((order)=>order.findings),...result.contracts,...result.performance,...result.rollbacks.flatMap((rollback)=>rollback.findings)]);
  if(format==="markdown")return [`# ${result.status==="passed"?"Passed":"Blocked"}: ${result.repository} PR #${result.currentPr}`,"",`Receipt: \`${result.provenance?.inputDigest??"not recorded"}\``,"",...findings.flatMap((finding)=>[`## ${finding.title}`,"",finding.message,"",`Next step: ${findingGuidance(finding.code).action}`,""] )].join("\n");
  return [`${result.status==="passed"?"PASS":"BLOCK"} ${result.repository} PR #${result.currentPr}`,`Receipt: ${result.provenance?.inputDigest??"not recorded"}`,...findings.flatMap((finding)=>[`${finding.severity.toUpperCase()} ${finding.code}: ${finding.title}`,`  ${finding.message}`,`  Next: ${findingGuidance(finding.code).action}`])].join("\n");
}

export async function inspectCache(directory:string):Promise<{directory:string;entries:number;bytes:number}> {
  const target=resolve(directory);const info=await lstat(target);if(!info.isDirectory())throw new Error("Cache path must be a directory.");
  let bytes=0;let entries=0;for(const entry of await readdir(target,{withFileTypes:true})){if(entry.isFile()&&entry.name.endsWith(".json")){entries++;bytes+=(await lstat(resolve(target,entry.name))).size;}}
  return {directory:target,entries,bytes};
}

export async function cleanCache(directory:string):Promise<{directory:string;removed:number}> {
  const target=resolve(directory);const root=resolve(target,sep);if(target===root)throw new Error("Refusing to clean a filesystem root.");
  const info=await lstat(target);if(!info.isDirectory())throw new Error("Cache path must be a directory.");
  let removed=0;for(const entry of await readdir(target,{withFileTypes:true})){if(entry.isFile()&&entry.name.endsWith(".json")){await unlink(resolve(target,entry.name));removed++;}}
  return {directory:target,removed};
}
