/**
 * Unwrap a backend error body for re-emission on a translated door.
 *
 * The Anthropic/Responses adapters run over the OpenAI-chat backend; when it
 * fails, its body is already an OpenAI error envelope. Re-wrapping that JSON
 * string as the `message` of a fresh `api_error` (the old behavior) both
 * double-encodes the message and misclassifies caller errors — a 400
 * `invalid_request_error` from the backend must stay an
 * `invalid_request_error` on the door.
 */
export function unwrapUpstreamError(
  detail: string,
  options: { readonly preserveMetadata?: boolean } = {}
): { type: string; message: string; code?: string; param?: string } {
  try {
    const parsed = JSON.parse(detail) as {
      error?: { type?: unknown; message?: unknown; code?: unknown; param?: unknown };
    };
    if (typeof parsed.error?.message === "string") {
      return {
        type: typeof parsed.error.type === "string" ? parsed.error.type : "api_error",
        message: parsed.error.message,
        ...(options.preserveMetadata === true &&
        typeof parsed.error.code === "string" &&
        parsed.error.code.length > 0
          ? { code: parsed.error.code }
          : {}),
        ...(options.preserveMetadata === true &&
        typeof parsed.error.param === "string" &&
        parsed.error.param.length > 0
          ? { param: parsed.error.param }
          : {})
      };
    }
  } catch {
    // not JSON — fall through to the raw detail
  }
  return { type: "api_error", message: detail.slice(0, 2000) };
}
