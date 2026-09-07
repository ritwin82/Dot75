import { execFile } from "node:child_process";
import {watch as watchFile} from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { parseMappings } from "@localmesh/contracts";
import { parseValidationInput, remediateValidationInput, runValidationInput, validationInputDigest } from "@localmesh/engine";
import { parseConfig, type ValidationResult } from "@localmesh/shared";
import { formatValidationResult, type ReportFormat } from "./report.js";
import {cleanCache,discoverLocal,explainResult,inspectCache} from "./cli-operations.js";

const run = promisify(execFile);
const commands = ["validate", "repro", "discover", "watch", "explain", "remediate", "doctor", "config check", "contracts check", "cache inspect", "cache clean"];
const usage = [
  "Usage:",
  "  localmesh validate --input localmesh-input.json [--output result] [--format json|human|markdown|sarif|junit] [--quiet]",
  "  localmesh repro --input localmesh-input.json [--output result] [--format json|human|markdown|sarif|junit]",
  "  localmesh validate --job <id> [--output result]",
  "  localmesh config check --input localmesh.yml",
  "  localmesh contracts check --input .localmesh/contracts.yml",
  "  localmesh discover --root . --config localmesh.yml",
  "  localmesh watch --input localmesh-input.json [--format human] [--once]",
  "  localmesh explain --input result.json [--format human|markdown]",
  "  localmesh remediate --input localmesh-input.json [--model qwen2.5-coder:7b] [--output remediation.json]",
  "  localmesh cache inspect --cache .localmesh-cache/github",
  "  localmesh cache clean --cache .localmesh-cache/github",
  "  localmesh doctor",
  "",
  "Exit codes: 0 = passed, 1 = verified failure, 2 = input or infrastructure error."
].join("\n");

interface Parsed { command: string; flags: Map<string, string>; quiet: boolean;once:boolean }
function parseArgs(args: string[]): Parsed {
  if (!args.length || args[0]!.startsWith("--")) args.unshift("validate");
  let command = args.shift()!;
  if ((command === "config" || command === "contracts") && args[0] === "check"||(command==="cache"&&(args[0]==="inspect"||args[0]==="clean"))) command += ` ${args.shift()}`;
  if (args.includes("--help") || args.includes("-h")) return { command: "help", flags: new Map(), quiet: false,once:false };
  if (!commands.includes(command)) throw new Error(usage);
  const flags = new Map<string, string>(); let quiet = false;let once=false;
  while (args.length) {
    const flag = args.shift()!;
    if (flag === "--quiet") { quiet = true; continue; }
    if(flag==="--once"){once=true;continue;}
    const value = args.shift();
    if (!["--input", "--output", "--job", "--format", "--model", "--url","--root","--config","--cache"].includes(flag) || !value || value.startsWith("--") || flags.has(flag)) throw new Error(usage);
    flags.set(flag, value);
  }
  return { command, flags, quiet,once };
}

async function doctor(): Promise<string> {
  const checks = [{ name: "Node.js", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.versions.node }];
  try {
    const { stdout } = await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000 });
    checks.push({ name: "Docker", ok: Boolean(stdout.trim()), detail: stdout.trim() || "unavailable" });
  } catch { checks.push({ name: "Docker", ok: false, detail: "unavailable" }); }
  if (checks.some((check) => !check.ok)) process.exitCode = 2;
  return checks.map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`).join("\n");
}

async function validate(command: string, flags: Map<string, string>): Promise<ValidationResult> {
  const inputPath = flags.get("--input"); const jobId = flags.get("--job");
  if (Boolean(inputPath) === Boolean(jobId)) throw new Error(usage);
  if (inputPath && flags.get("--output") && resolve(inputPath) === resolve(flags.get("--output")!)) throw new Error("The output file must differ from the input replay bundle.");
  if (inputPath) {
    if ((await stat(inputPath)).size > 64 * 1024 * 1024) throw new Error("Input replay bundles must be 64 MiB or smaller.");
    const source = JSON.parse(await readFile(inputPath, "utf8"));
    if (command === "repro") {
      const parsed = parseValidationInput(source); const expected = parsed.provenance?.inputDigest;
      if (expected && validationInputDigest(parsed) !== expected) throw new Error("The replay bundle digest does not match its recorded receipt.");
    }
    return runValidationInput(source);
  }
  const [{ loadJob, pool }, { validateJob }] = await Promise.all([import("@localmesh/db"), import("./validate.js")]);
  try { const job = await loadJob(jobId!); if (!job) throw new Error(`Job ${jobId} was not found`); return await validateJob(job); }
  finally { await pool.end(); }
}

async function main(): Promise<void> {
  const { command, flags, quiet,once } = parseArgs(process.argv.slice(2));
  if (command === "help") { console.log(usage); return; }
  if (command === "doctor") { const output = await doctor(); if (!quiet) process.stdout.write(`${output}\n`); return; }
  if(command==="discover"){
    const config=flags.get("--config")??"localmesh.yml";const value=await discoverLocal(flags.get("--root")??".",await readFile(config,"utf8"));const output=`${JSON.stringify(value,null,2)}\n`;if(flags.get("--output"))await writeFile(flags.get("--output")!,output,"utf8");if(!quiet)process.stdout.write(output);process.exitCode=(value.ready===true)?0:1;return;
  }
  if(command==="cache inspect"||command==="cache clean"){
    const cache=flags.get("--cache");if(!cache)throw new Error(usage);const value=command==="cache inspect"?await inspectCache(cache):await cleanCache(cache);const output=`${JSON.stringify(value,null,2)}\n`;if(!quiet)process.stdout.write(output);return;
  }
  if(command==="explain"){
    const input=flags.get("--input");if(!input)throw new Error(usage);const result=JSON.parse(await readFile(input,"utf8")) as ValidationResult;const format=flags.get("--format")??"human";if(format!=="human"&&format!=="markdown")throw new Error("Explain supports human or markdown format.");const output=`${explainResult(result,format)}\n`;if(flags.get("--output"))await writeFile(flags.get("--output")!,output,"utf8");if(!quiet)process.stdout.write(output);process.exitCode=result.status==="passed"?0:1;return;
  }
  if (command === "config check" || command === "contracts check") {
    const input = flags.get("--input"); if (!input) throw new Error(usage);
    const source = await readFile(input, "utf8");
    const value = command === "config check" ? parseConfig(source) : parseMappings(source);
    const output = `${JSON.stringify({ valid: true, command, value }, null, 2)}\n`;
    if (flags.get("--output")) await writeFile(flags.get("--output")!, output, "utf8");
    if (!quiet) process.stdout.write(output); return;
  }
  if(command==="remediate"){
    const input=flags.get("--input");if(!input)throw new Error(usage);const source=JSON.parse(await readFile(input,"utf8"));
    const model=flags.get("--model")??process.env.OLLAMA_MODEL;if(!model)throw new Error("Remediation requires --model or OLLAMA_MODEL.");
    const attempt=await remediateValidationInput(source,{model,url:flags.get("--url")??process.env.OLLAMA_URL??"http://localhost:11434",timeoutMs:Number(process.env.OLLAMA_TIMEOUT_MS??120000)});
    const output=`${JSON.stringify(attempt,null,2)}\n`;if(flags.get("--output"))await writeFile(flags.get("--output")!,output,"utf8");if(!quiet)process.stdout.write(output);process.exitCode=attempt.status==="unavailable"?2:attempt.candidates.some((candidate)=>candidate.status==="verified")||attempt.status==="not_needed"?0:1;return;
  }
  const format = (flags.get("--format") ?? "json") as ReportFormat;
  if (!["json", "human", "markdown", "sarif", "junit"].includes(format)) throw new Error(`Unsupported report format: ${format}`);
  const runOnce=async()=>{const result=await validate(command,flags);const output=`${formatValidationResult(result,format)}\n`;if(flags.get("--output"))await writeFile(flags.get("--output")!,output,"utf8");if(!quiet)process.stdout.write(output);process.exitCode=result.status==="passed"?0:1;};
  await runOnce();
  if(command==="watch"&&!once){const input=flags.get("--input");if(!input)throw new Error(usage);await new Promise<void>((finish)=>{let timer:NodeJS.Timeout|undefined;const watcher=watchFile(input,()=>{if(timer)clearTimeout(timer);timer=setTimeout(()=>{void runOnce().catch((error)=>process.stderr.write(`${String(error)}\n`));},250);});const stop=()=>{watcher.close();finish();};process.once("SIGINT",stop);process.once("SIGTERM",stop);});}
}

try { await main(); }
catch (error) {
  const issues = error !== null && typeof error === "object" && "issues" in error && Array.isArray(error.issues) ? error.issues : undefined;
  process.stderr.write(`${JSON.stringify({ error: "LocalMesh could not complete the command", message: issues ? "The input is invalid. Correct the listed fields and retry." : error instanceof Error ? error.message : String(error), ...(issues ? { issues } : {}) }, null, 2)}\n`);
  process.exitCode = 2;
}
