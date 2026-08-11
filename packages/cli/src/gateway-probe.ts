/** External data-plane readiness probe used by remote enrollment and display. */
export async function gatewayHealthy(
  url: string,
  input: { timeoutMs?: number; fetch?: typeof fetch } = {}
): Promise<boolean> {
  try {
    const response = await (input.fetch ?? fetch)(`${url}/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}
