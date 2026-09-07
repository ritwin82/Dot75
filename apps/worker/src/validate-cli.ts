import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runValidationInput } from "@localmesh/engine";
import type { ValidationResult } from "@localmesh/shared";

const usage = [
  "Usage:",
  "  pnpm localmesh validate --input localmesh-input.json [--output localmesh-result.json]",
  "  pnpm --filter @localmesh/worker validate --job <id> [--output localmesh-result.json]",
  "",
  "The JSON bundle contains immutable migrations, fixtures and trusted configuration.",
  "Offline replay requires Docker only when SQL must be executed; GitHub and the job database are optional.",
  "Exit codes: 0 = passed, 1 = verified failure, 2 = input or infrastructure error."
].join("\n");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "validate") args.shift();
  if (args.includes("--help") || args.includes("-h")) { console.log(usage); return; }
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !["--input", "--output", "--job"].includes(flag) || !value || value.startsWith("--") || flags.has(flag)) throw new Error(usage);
    flags.set(flag, value);
  }
  const inputPath = flags.get("--input");
  const jobId = flags.get("--job");
  if (Boolean(inputPath) === Boolean(jobId)) throw new Error(usage);
  const outputPath = flags.get("--output");
  if (inputPath && outputPath && resolve(inputPath) === resolve(outputPath)) throw new Error("The output file must differ from the input replay bundle.");
  let result: ValidationResult;
  if (inputPath) {
    if ((await stat(inputPath)).size > 64 * 1024 * 1024) throw new Error("Input replay bundles must be 64 MiB or smaller.");
    result = await runValidationInput(JSON.parse(await readFile(inputPath, "utf8")));
  } else {
    // Preserve database-backed replay without making the standalone path load credentials or open a pool.
    const [{ loadJob, pool }, { validateJob }] = await Promise.all([import("@localmesh/db"), import("./validate.js")]);
    try {
      const job = await loadJob(jobId!);
      if (!job) throw new Error(`Job ${jobId} was not found`);
      result = await validateJob(job);
    } finally { await pool.end(); }
  }
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized, "utf8");
  process.stdout.write(serialized);
  process.exitCode = result.status === "passed" ? 0 : 1;
}

try { await main(); }
catch (error) {
  const issues = error !== null && typeof error === "object" && "issues" in error && Array.isArray(error.issues) ? error.issues : undefined;
  process.stderr.write(`${JSON.stringify({
    error: "LocalMesh could not complete validation",
    message: issues ? "The replay input is invalid. Correct the listed fields and retry." : error instanceof Error ? error.message : String(error),
    ...(issues ? { issues } : {})
  }, null, 2)}\n`);
  process.exitCode = 2;
}
