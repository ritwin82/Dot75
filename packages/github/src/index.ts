import {createHmac,timingSafeEqual} from "node:crypto";
import {App} from "@octokit/app";
import {Octokit} from "@octokit/rest";
import type {Finding,MigrationFile,OrderResult,ValidationResult} from "@localmesh/shared";

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
  const errors=allFindings(result).filter((f)=>f.severity==="error");
  const warnings=allFindings(result).filter((f)=>f.severity==="warning");
  const conclusion=result.status==="cancelled"?"cancelled":errors.length?"failure":"success";
  await octokit.checks.update({owner,repo,check_run_id:checkRunId,status:"completed",conclusion,
    output:{title:errors.length?`${errors.length} migration problem(s) detected`:"Migrations are compatible",summary:checkSummary(result,errors,warnings),annotations:[...errors,...warnings].slice(0,50).filter((f)=>f.file).map((f)=>({path:f.file!,start_line:f.line??1,end_line:f.line??1,annotation_level:f.severity==="error"?"failure":"warning",message:f.message,title:f.title}))}});
}

export async function markCheckRunning(octokit:Octokit,owner:string,repo:string,id:number):Promise<void> {
  await octokit.checks.update({owner,repo,check_run_id:id,status:"in_progress",started_at:new Date().toISOString(),output:{title:"Testing migration combinations",summary:"LocalMesh is executing related pull requests in isolated PostgreSQL databases."}});
}

export async function markCheckInfrastructureFailure(octokit:Octokit,owner:string,repo:string,id:number,message:string):Promise<void> {
  await octokit.checks.update({owner,repo,check_run_id:id,status:"completed",conclusion:"failure",output:{title:"LocalMesh could not complete validation",summary:message.slice(0,65000)}});
}

export async function cancelCheck(octokit:Octokit,owner:string,repo:string,id:number):Promise<void>{await octokit.checks.update({owner,repo,check_run_id:id,status:"completed",conclusion:"cancelled",output:{title:"Superseded by a newer commit",summary:"This validation was cancelled because the pull request head changed."}});}

function allFindings(result:ValidationResult):Finding[]{return [...result.orders.flatMap((o)=>o.findings),...result.contracts,...result.rollbacks.flatMap((r)=>r.findings),...result.performance];}
function orderLine(order:OrderResult):string {return `- PR order ${order.order.map((n)=>`#${n}`).join(" → ")}: **${order.passed?"passed":"failed"}** (${order.durationMs} ms)`;}
export function checkSummary(result:ValidationResult,errors=allFindings(result).filter((f)=>f.severity==="error"),warnings=allFindings(result).filter((f)=>f.severity==="warning")):string {
  return [`Compared PR #${result.currentPr} with ${result.comparedPullRequests.length} related open pull request(s).`,``,...result.orders.map(orderLine),``,`**${errors.length} errors · ${warnings.length} warnings**`,``,...errors.slice(0,10).map((f)=>`- **${f.title}:** ${f.message}`),``,`Reproduce locally: \`pnpm --filter @localmesh/worker validate --job ${result.jobId}\``].join("\n").slice(0,65000);
}

export async function getTextFile(octokit:Octokit,owner:string,repo:string,path:string,ref:string):Promise<string|undefined>{
  try {const {data}=await octokit.repos.getContent({owner,repo,path,ref}); if(Array.isArray(data)||data.type!=="file"||!("content" in data)) return undefined; return Buffer.from(data.content,"base64").toString("utf8");} catch(error){if((error as {status?:number}).status===404)return undefined;throw error;}
}

export async function listMigrations(octokit:Octokit,owner:string,repo:string,ref:string,directory:string):Promise<MigrationFile[]> {
  const {data}=await octokit.git.getTree({owner,repo,tree_sha:ref,recursive:"true"});
  const paths=data.tree.filter((e)=>e.type==="blob"&&e.path?.startsWith(`${directory.replace(/\/$/,"")}/`)&&e.path.endsWith(".sql")).map((e)=>e.path!);
  const files:MigrationFile[]=[];
  for(const path of paths){const direction=path.endsWith(".down.sql")?"down":path.endsWith(".up.sql")?"up":undefined;if(!direction)continue;const sql=await getTextFile(octokit,owner,repo,path,ref);if(sql!==undefined)files.push({path,sql,direction,order:migrationOrder(path)});}
  return files.sort((a,b)=>a.order-b.order||a.path.localeCompare(b.path));
}

export async function listSqlFiles(octokit:Octokit,owner:string,repo:string,ref:string,directory:string):Promise<Array<{path:string;sql:string}>> {
  const {data}=await octokit.git.getTree({owner,repo,tree_sha:ref,recursive:"true"}); const result:Array<{path:string;sql:string}>=[];
  const paths=data.tree.filter((e)=>e.type==="blob"&&e.path?.startsWith(`${directory.replace(/\/$/,"")}/`)&&e.path.endsWith(".sql")).map((e)=>e.path!);
  for(const path of paths){const sql=await getTextFile(octokit,owner,repo,path,ref);if(sql!==undefined)result.push({path,sql});}
  return result.sort((a,b)=>a.path.localeCompare(b.path));
}

export async function pullRequestMigrations(octokit:Octokit,owner:string,repo:string,pr:number,headSha:string,directory:string):Promise<MigrationFile[]> {
  const changed=await octokit.paginate(octokit.pulls.listFiles,{owner,repo,pull_number:pr,per_page:100}); const files:MigrationFile[]=[];
  for(const item of changed.filter((f)=>f.status!=="removed"&&f.filename.startsWith(`${directory.replace(/\/$/,"")}/`)&&f.filename.endsWith(".sql"))){const direction=item.filename.endsWith(".down.sql")?"down":item.filename.endsWith(".up.sql")?"up":undefined;if(!direction)continue;const sql=await getTextFile(octokit,owner,repo,item.filename,headSha);if(sql!==undefined)files.push({path:item.filename,sql,direction,order:migrationOrder(item.filename)});}
  return files.sort((a,b)=>a.order-b.order||a.path.localeCompare(b.path));
}

function migrationOrder(path:string):number {const match=path.split("/").at(-1)?.match(/^(\d+)/);return match?Number(match[1]):Number.MAX_SAFE_INTEGER;}

export async function openPullRequests(octokit:Octokit,owner:string,repo:string,exclude:number){const prs=await octokit.paginate(octokit.pulls.list,{owner,repo,state:"open",per_page:100});return prs.filter((pr)=>pr.number!==exclude&&!pr.draft).map((pr)=>({number:pr.number,title:pr.title,headSha:pr.head.sha,baseSha:pr.base.sha,author:pr.user?.login??"unknown"}));}
