/** External data-plane readiness probe used by remote enrollment and display. */
import { executeWebRequest } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";

export function gatewayHealthy(
  url: string,
  input: { timeoutMs?: number } = {}
): Effect.Effect<boolean, never, HttpClient.HttpClient> {
  return executeWebRequest(`${url}/health`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000)
  }).pipe(
    Effect.map((response) => response.ok),
    Effect.orElseSucceed(() => false)
  );
}
