import {PgBoss} from "pg-boss";
import {ensureSchema} from "@localmesh/db";
import type {ValidationJob} from "@localmesh/shared";
import {validateJob} from "./validate.js";
const databaseUrl=process.env.DATABASE_URL;if(!databaseUrl)throw new Error("DATABASE_URL is required");await ensureSchema();const boss=new PgBoss({connectionString:databaseUrl});await boss.start();await boss.createQueue("validate-pr");
await boss.work<ValidationJob>("validate-pr",{batchSize:1,localConcurrency:Number(process.env.WORKER_CONCURRENCY??2)},async(jobs)=>{for(const job of jobs)await validateJob(job.data);});
console.log("LocalMesh worker is ready");async function shutdown(){await boss.stop();process.exit(0);}process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
