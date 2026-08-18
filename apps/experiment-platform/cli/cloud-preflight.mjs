#!/usr/bin/env node

import { Client } from "@neondatabase/serverless";
import { list } from "@vercel/blob";

const checks = [];

async function check(name, operation, required = true) {
  try {
    const detail = await operation();
    checks.push({ name, status: "pass", ...(detail === undefined ? {} : { detail }) });
  } catch (error) {
    checks.push({
      name,
      status: required ? "fail" : "warning",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not configured`);
  return value;
}

await check("node", () => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 22)) {
    throw new Error(`Node ${process.versions.node} is older than 22.22`);
  }
  return process.versions.node;
});

await check("api-authentication", () => {
  requiredEnvironment("EXPERIMENT_PLATFORM_API_TOKEN");
  requiredEnvironment("EXPERIMENT_PLATFORM_DASHBOARD_USER");
  requiredEnvironment("EXPERIMENT_PLATFORM_DASHBOARD_PASSWORD");
});

await check("project-role", () => {
  const role = requiredEnvironment("EXPERIMENT_PLATFORM_PROJECT_ROLE");
  if (role !== "development" && role !== "locked-evaluator") {
    throw new Error("EXPERIMENT_PLATFORM_PROJECT_ROLE must be development or locked-evaluator");
  }
  return role;
});

await check("postgres", async () => {
  const client = new Client({ connectionString: requiredEnvironment("DATABASE_URL") });
  await client.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    await client.end();
  }
});

await check("vercel-blob", async () => {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const storeId = process.env.BLOB_STORE_ID;
  const oidcToken = process.env.VERCEL_OIDC_TOKEN;
  if (!token && !(storeId && oidcToken)) {
    throw new Error("Blob requires BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID plus VERCEL_OIDC_TOKEN");
  }
  await list({
    limit: 1,
    ...(token ? { token } : { storeId, oidcToken })
  });
});

await check(
  "hosted-model-gateway",
  async () => {
    const routeKitGateway = process.env.ROUTEKIT_GATEWAY_URL;
    const aiGateway = process.env.AI_GATEWAY_URL;
    const gateway = routeKitGateway || aiGateway;
    if (!gateway) throw new Error("ROUTEKIT_GATEWAY_URL or AI_GATEWAY_URL is not configured");
    const token = routeKitGateway
      ? requiredEnvironment("ROUTEKIT_EVAL_TOKEN")
      : process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
    if (!token) throw new Error("AI Gateway requires AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN");
    const pathname = routeKitGateway ? "/health" : "/v1/models";
    const response = await fetch(`${gateway.replace(/\/$/, "")}${pathname}`, {
      headers: routeKitGateway ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`gateway health returned HTTP ${response.status}`);
    return routeKitGateway ? "routekit" : "vercel-ai-gateway";
  },
  false
);

console.log(JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2));
if (checks.some((entry) => entry.status === "fail")) process.exitCode = 1;
