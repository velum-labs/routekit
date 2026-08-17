import { getArtifactStore, getExperimentLedger } from "@/lib/platform";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; kind: string }> }
): Promise<Response> {
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
  const body = await getArtifactStore().get(artifact);
  const extension = kind === "report" ? "md" : "json";
  return new Response(new TextDecoder().decode(body), {
    headers: {
      "content-type": artifact.contentType,
      "content-disposition": `inline; filename="${snapshot.experiment.experimentId}-${kind}.${extension}"`,
      "cache-control": "private, no-store"
    }
  });
}
