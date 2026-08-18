import { freezeExperimentPlan } from "@velum-labs/routekit-eval-core/experiment";
import { parse as parseYaml } from "yaml";

import { actorFromRequest, requireMutationAuthorization } from "@/lib/auth";
import { getExperimentLedger } from "@/lib/platform";
import { startExperiment } from "@/lib/start-workflow";

export const runtime = "nodejs";

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = message === "unauthorized" ? 401 : 400;
  return Response.json({ error: message }, { status });
}

export async function GET(request: Request): Promise<Response> {
  try {
    requireMutationAuthorization(request);
    const experiments = await (await getExperimentLedger()).listExperiments();
    return Response.json({ experiments });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireMutationAuthorization(request);
    const raw = await request.text();
    const contentType = request.headers.get("content-type") ?? "";
    const manifest = contentType.includes("json") ? (JSON.parse(raw) as unknown) : parseYaml(raw);
    const plan = freezeExperimentPlan(manifest);
    if (
      plan.manifest.dataset.role === "locked_test" &&
      (process.env.EXPERIMENT_PLATFORM_PROJECT_ROLE !== "locked-evaluator" ||
        process.env.EXPERIMENT_PLATFORM_ALLOW_LOCKED_TEST !== "1")
    ) {
      throw new Error(
        "locked-test execution requires a separate locked-evaluator project and explicit enablement"
      );
    }
    if (
      process.env.VERCEL === "1" &&
      plan.jobs.some((job) => job.executor === "local")
    ) {
      throw new Error("local-command treatments cannot run on Vercel; use a Sandbox treatment");
    }
    const ledger = await getExperimentLedger();
    const snapshot = await ledger.createExperiment(plan);
    let workflowRunId: string | undefined;
    if (snapshot.experiment.status === "queued") {
      workflowRunId = await startExperiment(snapshot.experiment.experimentId);
    }
    return Response.json(
      {
        experiment: snapshot.experiment,
        jobs: snapshot.jobs.length,
        actor: actorFromRequest(request),
        workflowRunId
      },
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error);
  }
}
