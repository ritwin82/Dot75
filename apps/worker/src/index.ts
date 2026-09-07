import {PgBoss} from "pg-boss";
import {migrateDatabase} from "@localmesh/db";
import type {ValidationJob} from "@localmesh/shared";
import {validateJob} from "./validate.js";
import {runRemediationJob,type RemediationJob} from "./remediate-job.js";
const databaseUrl=process.env.DATABASE_URL;if(!databaseUrl)throw new Error("DATABASE_URL is required");await migrateDatabase();const boss=new PgBoss({connectionString:databaseUrl});await boss.start();await boss.createQueue("validate-pr");await boss.createQueue("remediate-job");
await boss.work<ValidationJob>("validate-pr",{batchSize:1,localConcurrency:Number(process.env.WORKER_CONCURRENCY??2)},async(jobs)=>{for(const job of jobs)await validateJob(job.data);});
await boss.work<RemediationJob>("remediate-job",{batchSize:1,localConcurrency:Number(process.env.REMEDIATION_CONCURRENCY??1)},async(jobs)=>{for(const job of jobs)await runRemediationJob(job.data);});
console.log("LocalMesh worker is ready");async function shutdown(){await boss.stop();process.exit(0);}process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
