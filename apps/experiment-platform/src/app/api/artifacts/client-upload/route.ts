import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

import { requireMutationAuthorization } from "@/lib/auth";
import { isContentAddressedInputPath } from "@/lib/artifact-reference";

export const runtime = "nodejs";

function maximumUploadBytes(): number {
  const configured = process.env.EXPERIMENT_PLATFORM_MAX_UPLOAD_BYTES;
  if (configured === undefined || configured.length === 0) return 5 * 1024 ** 3;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50 * 1024 ** 3) {
    throw new Error(
      "EXPERIMENT_PLATFORM_MAX_UPLOAD_BYTES must be an integer from 1 byte through 50 GiB"
    );
  }
  return parsed;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as HandleUploadBody;
    if (body.type === "blob.generate-client-token") {
      requireMutationAuthorization(request);
    }
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        if (!isContentAddressedInputPath(pathname)) {
          throw new Error(
            "client uploads require a content-addressed dataset, input, repository, index, embedding, or retrieval path"
          );
        }
        return {
          addRandomSuffix: false,
          allowOverwrite: false,
          maximumSizeInBytes: maximumUploadBytes(),
          validUntil: Date.now() + 60 * 60 * 1000
        };
      }
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: message === "unauthorized" ? 401 : 400 });
  }
}
