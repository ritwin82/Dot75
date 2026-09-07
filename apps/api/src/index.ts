import {randomUUID} from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import {PgBoss} from "pg-boss";
import {cancelStaleJobs,ensureSchema,getJob,listJobs,saveJob,setCheckRunId} from "@localmesh/db";
import {cancelCheck,createCheck,installationClient,verifyWebhookSignature} from "@localmesh/github";
import type {ValidationJob} from "@localmesh/shared";
import {extractPullRequest,resolveValidationBase} from "./webhook.js";

const server=Fastify({logger:true,bodyLimit:2_000_000});
await server.register(cors,{origin:process.env.WEB_ORIGIN??"http://localhost:3000"});
server.addContentTypeParser("application/json",{parseAs:"buffer"},(_request,body,done)=>done(null,body));

const databaseUrl=process.env.DATABASE_URL;if(!databaseUrl)throw new Error("DATABASE_URL is required");
await ensureSchema(); const boss=new PgBoss({connectionString:databaseUrl}); await boss.start(); await boss.createQueue("validate-pr");

server.get("/health",async()=>({status:"ok",service:"localmesh-api"}));
server.get("/api/jobs",async(request)=>{const query=request.query as {limit?:string};return {jobs:await listJobs(Number(query.limit??50))};});
server.get("/api/jobs/:id",async(request,reply)=>{const job=await getJob((request.params as {id:string}).id);return job??reply.code(404).send({error:"Job not found"});});

server.post("/webhooks/github",async(request,reply)=>{
  const raw=request.body as Buffer; const secret=process.env.GITHUB_WEBHOOK_SECRET;
  if(!secret)return reply.code(503).send({error:"Webhook secret is not configured"});
  if(!verifyWebhookSignature(raw,request.headers["x-hub-signature-256"] as string|undefined,secret))return reply.code(401).send({error:"Invalid webhook signature"});
  const event=request.headers["x-github-event"] as string|undefined;
  const payload=JSON.parse(raw.toString("utf8")) as Record<string,any>;
  if(event==="ping")return reply.send({ok:true});
  const extracted=extractPullRequest(event,payload); if(!extracted)return reply.code(202).send({ignored:true,event});
  const installationId=Number(payload.installation?.id); if(!installationId)return reply.code(422).send({error:"Missing installation id"});
  const client=await installationClient(installationId);
  const input=await resolveValidationBase(client,extracted,event,payload);
  const stale=input.prNumber===0?[]:await cancelStaleJobs(input.owner,input.repo,input.prNumber,input.headSha);
  await Promise.all(stale.flatMap((old)=>old.checkRunId?[cancelCheck(client,input.owner,input.repo,old.checkRunId)]:[]));
  const job:ValidationJob={id:randomUUID(),installationId,...input};
  const created=await saveJob(job);if(!created)return reply.code(202).send({accepted:false,reason:"An identical validation is already queued or complete"});
  const checkRunId=await createCheck(client,input.owner,input.repo,input.headSha);job.checkRunId=checkRunId;await setCheckRunId(job.id,checkRunId);
  await boss.send("validate-pr",job,{singletonKey:`${input.owner}/${input.repo}#${input.prNumber}:${input.headSha}:${input.baseSha}`});
  return reply.code(202).send({accepted:true,jobId:job.id,checkRunId});
});

const port=Number(process.env.API_PORT??4100);await server.listen({host:"0.0.0.0",port});
async function shutdown(){await server.close();await boss.stop();process.exit(0);}process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
