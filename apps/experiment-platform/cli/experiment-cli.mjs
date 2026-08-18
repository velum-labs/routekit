#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const argv = process.argv.slice(2);
if (argv[0] === "--") argv.shift();
const [command, ...args] = argv;
const baseUrl = (process.env.EXPERIMENT_PLATFORM_URL ?? "http://127.0.0.1:3010").replace(/\/$/, "");
const token = process.env.EXPERIMENT_PLATFORM_API_TOKEN;

function usage() {
  console.error(`Usage:
  pnpm experiments:cli upload <file> [kind]
  pnpm experiments:cli submit <manifest.yaml|json>
  pnpm experiments:cli status <experiment-id>
  pnpm experiments:cli approve <experiment-id> <paid_execution|confirmation|locked_test>
  pnpm experiments:cli cancel <experiment-id>
  pnpm experiments:cli report <experiment-id> [output.md]
  pnpm experiments:cli metrics <experiment-id> [output.json]

Environment:
  EXPERIMENT_PLATFORM_URL        Defaults to http://127.0.0.1:3010
  EXPERIMENT_PLATFORM_API_TOKEN  Required by protected deployments`);
}

function headers(extra = {}) {
  return {
    ...(token === undefined || token.length === 0 ? {} : { authorization: `Bearer ${token}` }),
    ...extra
  };
}

async function checkedFetch(pathname, init) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 4000)}`);
  }
  return response;
}

function requireArgument(value, label) {
  if (value === undefined || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function contentTypeFor(pathname) {
  const extension = extname(pathname).toLowerCase();
  if (extension === ".json") return "application/json";
  if (extension === ".yaml" || extension === ".yml") return "text/yaml";
  if (extension === ".md") return "text/markdown";
  if (extension === ".txt") return "text/plain";
  return "application/octet-stream";
}

async function upload() {
  const pathname = requireArgument(args[0], "file");
  const kind = args[1] ?? "inputs";
  const response = await checkedFetch("/api/artifacts", {
    method: "POST",
    headers: headers({
      "content-type": contentTypeFor(pathname),
      "x-artifact-kind": kind,
      "x-artifact-extension": extname(pathname).replace(/^\./, "") || "bin"
    }),
    body: await readFile(pathname)
  });
  console.log(JSON.stringify(await response.json(), null, 2));
}

async function submit() {
  const pathname = requireArgument(args[0], "manifest");
  const response = await checkedFetch("/api/experiments", {
    method: "POST",
    headers: headers({ "content-type": contentTypeFor(pathname) }),
    body: await readFile(pathname)
  });
  console.log(JSON.stringify(await response.json(), null, 2));
}

async function status() {
  const experimentId = requireArgument(args[0], "experiment id");
  const response = await checkedFetch(`/api/experiments/${encodeURIComponent(experimentId)}`, {
    headers: headers()
  });
  console.log(JSON.stringify(await response.json(), null, 2));
}

async function approve() {
  const experimentId = requireArgument(args[0], "experiment id");
  const stage = requireArgument(args[1], "approval stage");
  const response = await checkedFetch(
    `/api/experiments/${encodeURIComponent(experimentId)}/approve`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ stage, actor: process.env.USER ?? "experiment-cli" })
    }
  );
  console.log(JSON.stringify(await response.json(), null, 2));
}

async function cancel() {
  const experimentId = requireArgument(args[0], "experiment id");
  const response = await checkedFetch(`/api/experiments/${encodeURIComponent(experimentId)}`, {
    method: "DELETE",
    headers: headers()
  });
  console.log(JSON.stringify(await response.json(), null, 2));
}

async function downloadArtifact(kind) {
  const experimentId = requireArgument(args[0], "experiment id");
  const output = args[1];
  const response = await checkedFetch(
    `/api/experiments/${encodeURIComponent(experimentId)}/artifacts/${kind}`,
    { headers: headers() }
  );
  const body = new Uint8Array(await response.arrayBuffer());
  if (output !== undefined) {
    await writeFile(output, body);
    console.error(`Wrote ${kind} for ${experimentId} to ${basename(output)}.`);
    return;
  }
  process.stdout.write(body);
}

try {
  if (command === "upload") await upload();
  else if (command === "submit") await submit();
  else if (command === "status") await status();
  else if (command === "approve") await approve();
  else if (command === "cancel") await cancel();
  else if (command === "report") await downloadArtifact("report");
  else if (command === "metrics") await downloadArtifact("metrics");
  else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
