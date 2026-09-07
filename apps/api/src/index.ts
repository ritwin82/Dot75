import {randomUUID} from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import {PgBoss} from "pg-boss";
import {Octokit} from "@octokit/rest";
import {appendJobEvent,cancelStaleJobs,createRemediationAttempt,getJob,getRemediationAttempt,listJobEvents,listJobs,listRepositoryJobs,loadReplayInput,migrateDatabase,pool,saveAuditEvent,saveJob,setCheckRunId} from "@localmesh/db";
import {cancelCheck,createCheck,createContractConfigurationPullRequest,installationClient,previewContractChange,readContractConfiguration,verifyWebhookSignature} from "@localmesh/github";
import {ENGINE_VERSION,formatValidationResult,type ReportFormat,type ValidationJob,type ValidationResult} from "@localmesh/shared";
import {extractPullRequest,resolveValidationBase} from "./webhook.js";
import {buildCompatibilityGraph,type CompatibilityJob} from "./compatibility.js";
import {buildRecurrenceSnapshot} from "./recurrence.js";
import {githubSession,registerGitHubAuth,validCsrf} from "./auth.js";
import {openApiDocument} from "./openapi.js";
import {renderMetrics} from "./metrics.js";
import {authorizeRepository} from "./authorization.js";

const server=Fastify({logger:{redact:["req.headers.authorization","req.headers.cookie","res.headers.set-cookie","body.accessToken","body.token"]},bodyLimit:2_000_000});
await server.register(cors,{origin:process.env.WEB_ORIGIN??"http://localhost:3000",credentials:true,allowedHeaders:["content-type","x-dot75-csrf"]});
server.addContentTypeParser("application/json",{parseAs:"buffer"},(_request,body,done)=>done(null,body));
registerGitHubAuth(server);

const validRepositoryPart=(value:string)=>/^[\w.-]+$/.test(value);
function jsonBody(request:{body:unknown}):Record<string,unknown> {
  if(Buffer.isBuffer(request.body)) return JSON.parse(request.body.toString("utf8")) as Record<string,unknown>;
  return request.body as Record<string,unknown>;
}
function userClient(request:Parameters<typeof githubSession>[0]):{client:Octokit;session:NonNullable<ReturnType<typeof githubSession>>}|undefined {
  const session=githubSession(request); return session?{client:new Octokit({auth:session.accessToken}),session}:undefined;
}

const databaseUrl=process.env.DATABASE_URL;if(!databaseUrl)throw new Error("DATABASE_URL is required");
await migrateDatabase(); const boss=new PgBoss({connectionString:databaseUrl}); await boss.start(); await boss.createQueue("validate-pr");await boss.createQueue("remediate-job");

server.get("/health",async()=>({status:"ok",service:"localmesh-api"}));
server.get("/health/live",async()=>({status:"ok"}));
server.get("/health/ready",async(_request,reply)=>{try{await pool.query("SELECT 1");return{status:"ready",database:true,queue:true};}catch{return reply.code(503).send({status:"not_ready",database:false});}});
server.get("/metrics",async(_request,reply)=>{const [jobs,remediations]=await Promise.all([pool.query<{status:string;count:string}>("SELECT status,count(*)::text count FROM validation_jobs GROUP BY status ORDER BY status"),pool.query<{count:string}>("SELECT count(*)::text count FROM remediation_attempts WHERE status IN ('queued','running')")]);return reply.header("content-type","text/plain; version=0.0.4; charset=utf-8").send(renderMetrics(jobs.rows,Number(remediations.rows[0]?.count??0)));});
server.get("/api/openapi.json",async()=>openApiDocument(process.env.API_PUBLIC_ORIGIN??`http://localhost:${process.env.API_PORT??4100}`));
server.get("/api/jobs",async(request,reply)=>{const identity=userClient(request);if(!identity)return reply.code(401).send({error:"Sign in with GitHub to view validation evidence"});const query=request.query as {limit?:string};const jobs=await listJobs(Number(query.limit??50)) as Array<{owner:string;repo:string}>;const access=new Map<string,boolean>();await Promise.all([...new Set(jobs.map((job)=>`${job.owner}/${job.repo}`))].map(async(repository)=>{const [owner,repo]=repository.split("/") as [string,string];access.set(repository,Boolean(await authorizeRepository(identity.client,owner,repo)));}));return{jobs:jobs.filter((job)=>access.get(`${job.owner}/${job.repo}`))};});
server.get("/api/jobs/:id",async(request,reply)=>{const identity=userClient(request);if(!identity)return reply.code(401).send({error:"Sign in with GitHub to view validation evidence"});const job=await getJob((request.params as {id:string}).id) as {owner:string;repo:string}|null;if(!job)return reply.code(404).send({error:"Job not found"});if(!await authorizeRepository(identity.client,job.owner,job.repo))return reply.code(403).send({error:"GitHub did not authorize access to this repository"});return job;});
server.get("/api/jobs/:id/export/:format",async(request,reply)=>{
  const identity=userClient(request);if(!identity)return reply.code(401).send({error:"Sign in with GitHub to export validation evidence"});const {id,format}=request.params as {id:string;format:string};const job=await getJob(id) as {owner:string;repo:string;result?:ValidationResult}|null;
  if(!job)return reply.code(404).send({error:"Job not found"});if(!job.result)return reply.code(409).send({error:"This validation does not have a completed result yet"});
  if(!await authorizeRepository(identity.client,job.owner,job.repo))return reply.code(403).send({error:"GitHub did not authorize access to this repository"});
  if(!["json","markdown","sarif","junit"].includes(format))return reply.code(400).send({error:"Unsupported export format"});
  const selected=format as Exclude<ReportFormat,"human">;const extensions={json:"json",markdown:"md",sarif:"sarif",junit:"xml"};const contentTypes={json:"application/json",markdown:"text/markdown; charset=utf-8",sarif:"application/sarif+json",junit:"application/xml; charset=utf-8"};
  return reply.header("content-type",contentTypes[selected]).header("content-disposition",`attachment; filename=dot75-${id}.${extensions[selected]}`).send(formatValidationResult(job.result,selected));
});
server.get("/api/jobs/:id/events",async(request,reply)=>{
  const identity=userClient(request);if(!identity)return reply.code(401).send({error:"Sign in with GitHub to view validation progress"});const id=(request.params as {id:string}).id; const job=await getJob(id) as {owner:string;repo:string}|null;if(!job)return reply.code(404).send({error:"Job not found"});if(!await authorizeRepository(identity.client,job.owner,job.repo))return reply.code(403).send({error:"GitHub did not authorize access to this repository"});
  const after=Number((request.query as {after?:string}).after??0);
  if(!request.headers.accept?.includes("text/event-stream")) return {events:await listJobEvents(id,after)};
  reply.hijack(); reply.raw.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-transform",connection:"keep-alive","x-accel-buffering":"no"});
  let cursor=Number.isFinite(after)?after:0; let active=true; let timer:NodeJS.Timeout|undefined;let heartbeat:NodeJS.Timeout|undefined;
  request.raw.once("close",()=>{active=false;if(timer)clearInterval(timer);if(heartbeat)clearInterval(heartbeat);});
  const flush=async()=>{try{for(const event of await listJobEvents(id,cursor)){cursor=event.id;reply.raw.write(`id: ${event.id}\nevent: job-stage\ndata: ${JSON.stringify(event)}\n\n`);}}catch(error){reply.raw.write(`event: error\ndata: ${JSON.stringify({message:error instanceof Error?error.message:String(error)})}\n\n`);}};
  await flush(); timer=setInterval(()=>{if(active)void flush();},1000); heartbeat=setInterval(()=>{if(active)reply.raw.write(": keep-alive\n\n");},15000);
});
server.post("/api/jobs/:id/remediate",async(request,reply)=>{
  const id=(request.params as {id:string}).id;const identity=userClient(request);if(!identity)return reply.code(401).send({error:"Sign in with GitHub to use the remediation lab"});
  if(!validCsrf(request,identity.session))return reply.code(403).send({error:"Invalid CSRF token"});
  const job=await getJob(id) as {owner:string;repo:string;status:string;result?:ValidationResult}|null;if(!job)return reply.code(404).send({error:"Job not found"});
  if(!await authorizeRepository(identity.client,job.owner,job.repo,"maintainer"))return reply.code(403).send({error:"Maintainer access is required for remediation"});
  if(job.status!=="failed")return reply.code(409).send({error:"Remediation is available only for completed deterministic failures"});
  const replay=await loadReplayInput(id);if(!replay)return reply.code(409).send({error:"This historical validation does not contain a replay bundle"});
  const attemptId=randomUUID();await createRemediationAttempt(attemptId,id,identity.session.login);await appendJobEvent(id,"remediating","started","Remediation is queued for an isolated worker.",{attemptId});
  await boss.send("remediate-job",{attemptId,jobId:id,actor:identity.session.login},{singletonKey:`remediation:${id}:${attemptId}`});
  return reply.code(202).send({attemptId,status:"queued"});
});
server.get("/api/remediations/:id",async(request,reply)=>{
  const identity=userClient(request);if(!identity)return reply.code(401).send({error:"Sign in with GitHub to use the remediation lab"});const attempt=await getRemediationAttempt((request.params as {id:string}).id) as {jobId:string;owner:string;repo:string;status:string;result?:unknown;error?:string}|null;if(!attempt)return reply.code(404).send({error:"Remediation attempt not found"});
  if(!await authorizeRepository(identity.client,attempt.owner,attempt.repo,"maintainer"))return reply.code(403).send({error:"Maintainer access is required for remediation"});
  const replay=attempt.status==="completed"?await loadReplayInput(attempt.jobId) as {current?:{files?:unknown[]}}|undefined:undefined;return {...attempt,originalFiles:replay?.current?.files??[]};
});
server.get("/api/repositories/:owner/:repo/compatibility",async(request,reply)=>{
  const {owner,repo}=request.params as {owner:string;repo:string};
  const identity=userClient(request);if(!identity)return reply.code(401).send({error:"Sign in with GitHub to view compatibility evidence"});
  if(!/^[\w.-]+$/.test(owner)||!/^[\w.-]+$/.test(repo))return reply.code(400).send({error:"Invalid repository"});
  if(!await authorizeRepository(identity.client,owner,repo))return reply.code(403).send({error:"GitHub did not authorize access to this repository"});
  const graph=buildCompatibilityGraph(`${owner}/${repo}`,await listRepositoryJobs(owner,repo) as CompatibilityJob[]);
  return graph??reply.code(404).send({error:"No completed validation snapshot exists for this repository"});
});
server.get("/api/repositories/:owner/:repo/recurrence",async(request,reply)=>{
  const {owner,repo}=request.params as {owner:string;repo:string};if(!/^[\w.-]+$/.test(owner)||!/^[\w.-]+$/.test(repo))return reply.code(400).send({error:"Invalid repository"});
  const identity=userClient(request);if(!identity)return reply.code(401).send({error:"Sign in with GitHub to view recurrence evidence"});if(!await authorizeRepository(identity.client,owner,repo))return reply.code(403).send({error:"GitHub did not authorize access to this repository"});
  return buildRecurrenceSnapshot(`${owner}/${repo}`,await listRepositoryJobs(owner,repo,500) as CompatibilityJob[]);
});
server.get("/api/repositories/:owner/:repo/contracts",async(request,reply)=>{
  const {owner,repo}=request.params as {owner:string;repo:string}; const identity=userClient(request);
  if(!identity) return reply.code(401).send({error:"Sign in with GitHub to configure contracts"});
  if(!validRepositoryPart(owner)||!validRepositoryPart(repo)) return reply.code(400).send({error:"Invalid repository"});
  const role=await authorizeRepository(identity.client,owner,repo);if(!role)return reply.code(403).send({error:"GitHub did not authorize access to this repository"});
  try {return {...await readContractConfiguration(identity.client,owner,repo),role};}
  catch(error){const status=(error as {status?:number}).status;return reply.code(status===404?404:status===403?403:502).send({error:error instanceof Error?error.message:String(error)});}
});
server.post("/api/repositories/:owner/:repo/contracts/preview",async(request,reply)=>{
  const {owner,repo}=request.params as {owner:string;repo:string}; const identity=userClient(request);
  if(!identity) return reply.code(401).send({error:"Sign in with GitHub to configure contracts"});
  if(!validCsrf(request,identity.session)) return reply.code(403).send({error:"Invalid CSRF token"});
  if(!validRepositoryPart(owner)||!validRepositoryPart(repo)) return reply.code(400).send({error:"Invalid repository"});
  if(!await authorizeRepository(identity.client,owner,repo,"maintainer"))return reply.code(403).send({error:"Maintainer access is required to preview contract changes"});
  try {
    const body=jsonBody(request); const proposedSource=typeof body.proposedSource==="string"?body.proposedSource:"";
    if(Buffer.byteLength(proposedSource)>200_000) return reply.code(413).send({error:"Contract configuration is larger than 200 KB"});
    const current=await readContractConfiguration(identity.client,owner,repo);
    return {baseSha:current.baseSha,defaultBranch:current.defaultBranch,preview:previewContractChange(current.source,proposedSource)};
  } catch(error) {return reply.code(422).send({error:error instanceof Error?error.message:String(error)});}
});
server.post("/api/repositories/:owner/:repo/contracts/pull-request",async(request,reply)=>{
  const {owner,repo}=request.params as {owner:string;repo:string}; const identity=userClient(request);
  if(!identity) return reply.code(401).send({error:"Sign in with GitHub to configure contracts"});
  if(!validCsrf(request,identity.session)) return reply.code(403).send({error:"Invalid CSRF token"});
  if(!validRepositoryPart(owner)||!validRepositoryPart(repo)) return reply.code(400).send({error:"Invalid repository"});
  if(!await authorizeRepository(identity.client,owner,repo,"maintainer"))return reply.code(403).send({error:"Maintainer access is required to create a configuration pull request"});
  try {
    const body=jsonBody(request);
    if(body.confirmed!==true||typeof body.baseSha!=="string"||typeof body.proposedSource!=="string") return reply.code(400).send({error:"Explicit confirmation, preview base SHA, and proposed configuration are required"});
    if(Buffer.byteLength(body.proposedSource)>200_000) return reply.code(413).send({error:"Contract configuration is larger than 200 KB"});
    const created=await createContractConfigurationPullRequest(identity.client,{owner,repo,expectedBaseSha:body.baseSha,proposedSource:body.proposedSource,actor:identity.session.login});
    await saveAuditEvent({actor:identity.session.login,action:"contracts.pull_request.created",owner,repo,details:{pullRequest:created.number,branch:created.branch,baseSha:created.baseSha,digest:created.preview.digest}});
    return created;
  } catch(error) {
    const message=error instanceof Error?error.message:String(error); const status=message.includes("default branch changed")?409:(error as {status?:number}).status;
    return reply.code(status===403?403:status===409?409:422).send({error:message});
  }
});

server.post("/webhooks/github",async(request,reply)=>{
  if((process.env.DOT75_DELIVERY_MODE??"app")!=="app")return reply.code(202).send({ignored:true,reason:"GitHub App publication is disabled by the operator-selected delivery mode"});
  const raw=request.body as Buffer; const secret=process.env.GITHUB_WEBHOOK_SECRET;
  if(!secret)return reply.code(503).send({error:"Webhook secret is not configured"});
  if(!verifyWebhookSignature(raw,request.headers["x-hub-signature-256"] as string|undefined,secret))return reply.code(401).send({error:"Invalid webhook signature"});
  const event=request.headers["x-github-event"] as string|undefined;
  const payload=JSON.parse(raw.toString("utf8")) as Record<string,any>;
  if(event==="ping")return reply.send({ok:true});
  if(payload.repository?.private!==true)return reply.code(403).send({error:"Dot75 is configured for private trusted repositories; public-repository execution is disabled"});
  const extracted=extractPullRequest(event,payload); if(!extracted)return reply.code(202).send({ignored:true,event});
  const installationId=Number(payload.installation?.id); if(!installationId)return reply.code(422).send({error:"Missing installation id"});
  const client=await installationClient(installationId);
  const input=await resolveValidationBase(client,extracted,event,payload);
  const stale=input.prNumber===0?[]:await cancelStaleJobs(input.owner,input.repo,input.prNumber,input.headSha);
  await Promise.all(stale.flatMap((old)=>old.checkRunId?[cancelCheck(client,input.owner,input.repo,old.checkRunId)]:[]));
  const job:ValidationJob={id:randomUUID(),installationId,...input,engineVersion:ENGINE_VERSION};
  const created=await saveJob(job);if(!created)return reply.code(202).send({accepted:false,reason:"An identical validation is already queued or complete"});
  await appendJobEvent(job.id,"discovery","started","GitHub revisions were accepted and migration discovery is queued.",{headSha:job.headSha,baseSha:job.baseSha});
  const checkRunId=await createCheck(client,input.owner,input.repo,input.headSha,{pr:input.prNumber,baseSha:input.baseSha,engineVersion:ENGINE_VERSION});job.checkRunId=checkRunId;await setCheckRunId(job.id,checkRunId);
  await boss.send("validate-pr",job,{singletonKey:`${input.owner}/${input.repo}#${input.prNumber}:${input.headSha}:${input.baseSha}:${ENGINE_VERSION}`});
  return reply.code(202).send({accepted:true,jobId:job.id,checkRunId});
});

const port=Number(process.env.API_PORT??4100);await server.listen({host:"0.0.0.0",port});
async function shutdown(){await server.close();await boss.stop();process.exit(0);}process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
