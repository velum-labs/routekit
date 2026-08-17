import { requireMutationAuthorization } from "@/lib/auth";
import { getArtifactStore, getExperimentLedger } from "@/lib/platform";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; kind: string }> }
): Promise<Response> {
  try {
    requireMutationAuthorization(request);
    const { id, kind } = await context.params;
    const snapshot = await (await getExperimentLedger()).getExperiment(decodeURIComponent(id));
    if (snapshot === undefined) return new Response("Not found", { status: 404 });
    const artifact =
      kind === "report"
        ? snapshot.experiment.reportArtifact
        : kind === "metrics"
          ? snapshot.experiment.metricsArtifact
          : undefined;
    if (artifact === undefined) return new Response("Not found", { status: 404 });
    return new Response(new TextDecoder().decode(await getArtifactStore().get(artifact)), {
      headers: {
        "content-type": artifact.contentType,
        "cache-control": "private, no-store"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: message === "unauthorized" ? 401 : 400 });
  }
}
