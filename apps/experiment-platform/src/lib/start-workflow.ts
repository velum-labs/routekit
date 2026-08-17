import { Client } from "@neondatabase/serverless";
import { start } from "workflow/api";

import { runExperimentWorkflow } from "@/workflows/experiment";

declare global {
  var routeKitExperimentWorkflowStarts: Map<string, Promise<string>> | undefined;
}

async function startWorkflowRun(experimentId: string): Promise<string> {
  const run = await start(runExperimentWorkflow, [experimentId]);
  return run.runId;
}

async function startLocalExperiment(experimentId: string): Promise<string> {
  const starts =
    globalThis.routeKitExperimentWorkflowStarts ??
    (globalThis.routeKitExperimentWorkflowStarts = new Map());
  const existing = starts.get(experimentId);
  if (existing !== undefined) return existing;
  const pending = startWorkflowRun(experimentId);
  starts.set(experimentId, pending);
  try {
    return await pending;
  } catch (error) {
    if (starts.get(experimentId) === pending) starts.delete(experimentId);
    throw error;
  }
}

export async function startExperiment(experimentId: string): Promise<string> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    return startLocalExperiment(experimentId);
  }

  const client = new Client({ connectionString });
  await client.connect();
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `experiment-workflow:${experimentId}`
    ]);
    const existing = await client.query(
      `SELECT workflow_run_id
       FROM experiment_workflow_runs
       WHERE experiment_id = $1
       ORDER BY created_at
       LIMIT 1`,
      [experimentId]
    );
    const existingRunId = existing.rows[0]?.workflow_run_id;
    if (typeof existingRunId === "string") {
      await client.query("COMMIT");
      return existingRunId;
    }

    const workflowRunId = await startWorkflowRun(experimentId);
    await client.query(
      `INSERT INTO experiment_workflow_runs (workflow_run_id, experiment_id)
       VALUES ($1, $2)`,
      [workflowRunId, experimentId]
    );
    await client.query("COMMIT");
    return workflowRunId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}
