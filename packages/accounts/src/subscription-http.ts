export type SubscriptionJsonResponse = {
  response: Response;
  body: unknown;
  hasJsonBody: boolean;
};

export async function fetchSubscriptionJson(input: {
  endpoint: string;
  headers?: Record<string, string>;
  method?: string;
  body?: string | URLSearchParams;
  signal?: AbortSignal;
}): Promise<SubscriptionJsonResponse> {
  const response = await fetch(input.endpoint, {
    ...(input.method !== undefined ? { method: input.method } : {}),
    headers: { accept: "application/json", ...input.headers },
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {})
  });
  try {
    return { response, body: await response.json(), hasJsonBody: true };
  } catch {
    return { response, body: undefined, hasJsonBody: false };
  }
}
