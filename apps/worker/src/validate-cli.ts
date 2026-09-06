import {loadJob} from "@localmesh/db";
import {validateJob} from "./validate.js";
const index=process.argv.indexOf("--job");const id=index>=0?process.argv[index+1]:undefined;if(!id)throw new Error("Usage: pnpm --filter @localmesh/worker validate --job <id>");const job=await loadJob(id);if(!job)throw new Error(`Job ${id} was not found`);console.log(JSON.stringify(await validateJob(job),null,2));
