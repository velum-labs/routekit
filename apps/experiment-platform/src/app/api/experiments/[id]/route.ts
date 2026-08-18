import { requireMutationAuthorization } from "@/lib/auth";
import { getExperimentLedger } from "@/lib/platform";

export const runtime = "nodejs";

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json({ error: message }, { status: message === "unauthorized" ? 401 : 400 });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    requireMutationAuthorization(request);
    const { id } = await context.params;
    const snapshot = await (await getExperimentLedger()).getExperiment(decodeURIComponent(id));
    if (snapshot === undefined) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(snapshot);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    requireMutationAuthorization(request);
    const { id } = await context.params;
    await (await getExperimentLedger()).cancelExperiment(decodeURIComponent(id));
    return Response.json({ cancelled: true });
  } catch (error) {
    return errorResponse(error);
  }
}
