import { readFile, writeFile } from "node:fs/promises";

const inputPath = process.env.ROUTEKIT_EXPERIMENT_INPUT;
const outputPath = process.env.ROUTEKIT_EXPERIMENT_OUTPUT;
const input =
  inputPath === undefined
    ? Buffer.concat(await Array.fromAsync(process.stdin))
    : await readFile(inputPath);
const configuration = JSON.parse(process.env.ROUTEKIT_EXPERIMENT_CONFIGURATION ?? "{}");
let parsed;
try {
  parsed = JSON.parse(input.toString("utf8"));
} catch {
  parsed = { text: input.toString("utf8") };
}

const output = {
  infrastructureHealthCheck: true,
  experimentId: process.env.ROUTEKIT_EXPERIMENT_ID,
  jobId: process.env.ROUTEKIT_EXPERIMENT_JOB_ID,
  taskId: process.env.ROUTEKIT_EXPERIMENT_TASK_ID,
  treatmentId: process.env.ROUTEKIT_EXPERIMENT_TREATMENT_ID,
  seed: Number(process.env.ROUTEKIT_EXPERIMENT_SEED),
  configuration,
  input: parsed
};

if (outputPath !== undefined) {
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(output)}\n`);
