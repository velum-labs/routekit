import type { ExperimentApprovalStage } from "@velum-labs/routekit-eval-contracts";

import { actorFromRequest, requireMutationAuthorization } from "@/lib/auth";
import { getExperimentLedger } from "@/lib/platform";
import { startExperiment } from "@/lib/start-workflow";

export const runtime = "nodejs";

const STAGES = new Set<ExperimentApprovalStage>(["paid_execution", "confirmation", "locked_test"]);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    requireMutationAuthorization(request);
    const body = (await request.json()) as { stage?: unknown; actor?: unknown };
    if (typeof body.stage !== "string" || !STAGES.has(body.stage as ExperimentApprovalStage)) {
      throw new Error("stage must be paid_execution, confirmation, or locked_test");
    }
    const { id } = await context.params;
    const experimentId = decodeURIComponent(id);
    const ledger = await getExperimentLedger();
    const approval = await ledger.approve(
      experimentId,
      body.stage as ExperimentApprovalStage,
      typeof body.actor === "string" && body.actor.trim() !== ""
        ? body.actor
        : actorFromRequest(request)
    );
    const snapshot = await ledger.getExperiment(experimentId);
    const workflowRunId =
      snapshot?.experiment.status === "queued" ? await startExperiment(experimentId) : undefined;
    return Response.json({ approval, workflowRunId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: message === "unauthorized" ? 401 : 400 });
  }
}
