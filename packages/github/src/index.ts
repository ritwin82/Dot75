import {createHmac,timingSafeEqual} from "node:crypto";
import {App} from "@octokit/app";
import {Octokit} from "@octokit/rest";
import type {MigrationFile,ValidationResult} from "@localmesh/shared";
import {checkAnnotations,checkConclusion,checkSummary,checkTitle} from "./reporting.js";
import {migrationDirectoryPrefix} from "./discovery.js";
export * from "./reporting.js";
export * from "./discovery.js";

export function verifyWebhookSignature(raw:Buffer,signature:string|undefined,secret:string):boolean {
  if(!signature?.startsWith("sha256=")) return false;
  const expected=`sha256=${createHmac("sha256",secret).update(raw).digest("hex")}`;
  const a=Buffer.from(signature); const b=Buffer.from(expected);
  return a.length===b.length&&timingSafeEqual(a,b);
}

let app:App|undefined;
export function githubApp():App {
  if(app) return app;
  const appId=process.env.GITHUB_APP_ID; const privateKey=process.env.GITHUB_PRIVATE_KEY?.replaceAll("\\n","\n");
  if(!appId||!privateKey) throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY are required");
  app=new App({appId,privateKey,Octokit}); return app;
}
export async function installationClient(id:number):Promise<Octokit> { return await githubApp().getInstallationOctokit(id) as unknown as Octokit; }

export async function createCheck(octokit:Octokit,owner:string,repo:string,headSha:string):Promise<number> {
  const {data}=await octokit.checks.create({owner,repo,name:"LocalMesh Sensei",head_sha:headSha,status:"queued",output:{title:"Migration analysis queued",summary:"LocalMesh is preparing isolated PostgreSQL validation."}});
  return data.id;
}

export async function updateCheck(octokit:Octokit,owner:string,repo:string,checkRunId:number,result:ValidationResult):Promise<void> {
  await octokit.checks.update({owner,repo,check_run_id:checkRunId,status:"completed",conclusion:checkConclusion(result),
    output:{title:checkTitle(result),summary:checkSummary(result),annotations:checkAnnotations(result)}});
}

export async function markCheckRunning(octokit:Octokit,owner:string,repo:string,id:number):Promise<void> {
  await octokit.checks.update({owner,repo,check_run_id:id,status:"in_progress",started_at:new Date().toISOString(),output:{title:"Testing migration combinations",summary:"LocalMesh is executing related pull requests in isolated PostgreSQL databases."}});
}

export async function markCheckInfrastructureFailure(octokit:Octokit,owner:string,repo:string,id:number,message:string):Promise<void> {
  await octokit.checks.update({owner,repo,check_run_id:id,status:"completed",conclusion:"failure",output:{title:"LocalMesh could not complete validation",summary:message.slice(0,65000)}});
}

export async function cancelCheck(octokit:Octokit,owner:string,repo:string,id:number):Promise<void>{await octokit.checks.update({owner,repo,check_run_id:id,status:"completed",conclusion:"cancelled",output:{title:"Superseded by a newer commit",summary:"This validation was cancelled because the pull request head changed."}});}

export async function getTextFile(octokit:Octokit,owner:string,repo:string,path:string,ref:string):Promise<string|undefined>{
  try {const {data}=await octokit.repos.getContent({owner,repo,path,ref}); if(Array.isArray(data)||data.type!=="file"||!("content" in data)) return undefined; if(data.encoding!=="base64")throw new Error(`GitHub did not return the complete contents of ${path} at ${ref}.`); const decoded=Buffer.from(data.content,"base64");if(decoded.length!==data.size)throw new Error(`GitHub returned incomplete contents for ${path} at ${ref}.`);return decoded.toString("utf8");} catch(error){if((error as {status?:number}).status===404)return undefined;throw error;}
}

export async function listMigrations(octokit:Octokit,owner:string,repo:string,ref:string,directory:string):Promise<MigrationFile[]> {
  const {data}=await octokit.git.getTree({owner,repo,tree_sha:ref,recursive:"true"});
  if(data.truncated)throw new Error(`GitHub truncated the migration tree at ${ref}; validation cannot use an incomplete baseline.`);
  const prefix=migrationDirectoryPrefix(directory);
  const paths=data.tree.filter((e)=>e.type==="blob"&&e.path?.startsWith(prefix)&&e.path.endsWith(".sql")).map((e)=>e.path!);
  const files:MigrationFile[]=[];
  for(const path of paths){const direction=path.endsWith(".down.sql")?"down":path.endsWith(".up.sql")?"up":undefined;if(!direction)throw new Error(`Unsupported baseline migration ${path}; expected .up.sql or .down.sql.`);const sql=await getTextFile(octokit,owner,repo,path,ref);if(sql===undefined)throw new Error(`Could not read baseline migration ${path} at ${ref}.`);files.push({path,sql,direction,order:migrationOrder(path)});}
  return files.sort((a,b)=>a.order-b.order||a.path.localeCompare(b.path));
}

export async function listSqlFiles(octokit:Octokit,owner:string,repo:string,ref:string,directory:string):Promise<Array<{path:string;sql:string}>> {
  const {data}=await octokit.git.getTree({owner,repo,tree_sha:ref,recursive:"true"}); const result:Array<{path:string;sql:string}>=[];
  if(data.truncated)throw new Error(`GitHub truncated the SQL file tree at ${ref}; validation cannot use incomplete fixtures.`);
  const prefix=migrationDirectoryPrefix(directory);
  const paths=data.tree.filter((e)=>e.type==="blob"&&e.path?.startsWith(prefix)&&e.path.endsWith(".sql")).map((e)=>e.path!);
  for(const path of paths){const sql=await getTextFile(octokit,owner,repo,path,ref);if(sql===undefined)throw new Error(`Could not read SQL file ${path} at ${ref}.`);result.push({path,sql});}
  return result.sort((a,b)=>a.path.localeCompare(b.path));
}

export async function pullRequestMigrations(octokit:Octokit,owner:string,repo:string,pr:number,headSha:string,directory:string):Promise<MigrationFile[]> {
  const changed=await octokit.paginate(octokit.pulls.listFiles,{owner,repo,pull_number:pr,per_page:100}); const files:MigrationFile[]=[];
  for(const item of changed.filter((f)=>f.status!=="removed"&&f.filename.startsWith(`${directory.replace(/\/$/,"")}/`)&&f.filename.endsWith(".sql"))){const direction=item.filename.endsWith(".down.sql")?"down":item.filename.endsWith(".up.sql")?"up":undefined;if(!direction)continue;const sql=await getTextFile(octokit,owner,repo,item.filename,headSha);if(sql!==undefined)files.push({path:item.filename,sql,direction,order:migrationOrder(item.filename)});}
  return files.sort((a,b)=>a.order-b.order||a.path.localeCompare(b.path));
}

function migrationOrder(path:string):number {const match=path.split("/").at(-1)?.match(/^(\d+)/);return match?Number(match[1]):Number.MAX_SAFE_INTEGER;}

export async function openPullRequests(octokit:Octokit,owner:string,repo:string,exclude:number){const prs=await octokit.paginate(octokit.pulls.list,{owner,repo,state:"open",per_page:100});return prs.filter((pr)=>pr.number!==exclude&&!pr.draft).map((pr)=>({number:pr.number,title:pr.title,headSha:pr.head.sha,baseSha:pr.base.sha,author:pr.user?.login??"unknown"}));}
