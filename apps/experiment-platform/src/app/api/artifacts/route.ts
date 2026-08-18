import { requireMutationAuthorization } from "@/lib/auth";
import { getArtifactStore } from "@/lib/platform";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    requireMutationAuthorization(request);
    const contentType = request.headers.get("content-type") ?? "application/octet-stream";
    const kind = request.headers.get("x-artifact-kind") ?? "inputs";
    const extension = request.headers.get("x-artifact-extension") ?? undefined;
    const body = new Uint8Array(await request.arrayBuffer());
    const artifact = await getArtifactStore().put(body, {
      kind,
      contentType,
      extension
    });
    return Response.json({ artifact }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: message === "unauthorized" ? 401 : 400 });
  }
}
