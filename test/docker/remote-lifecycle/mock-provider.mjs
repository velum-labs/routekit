#!/usr/bin/env node
/**
 * Deterministic OpenAI-compatible mock used by the remote Docker E2E target.
 * Speaks /health-adjacent model listing and chat completions on loopback.
 */
import { createServer } from "node:http";

const port = Number.parseInt(process.env.MOCK_PROVIDER_PORT ?? "17999", 10);
const host = process.env.MOCK_PROVIDER_HOST ?? "127.0.0.1";
const model = process.env.MOCK_PROVIDER_MODEL ?? "gpt-5.5";

const server = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  const url = request.url ?? "/";
  if (url === "/health" || url === "/v1/health") {
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.startsWith("/v1/models")) {
    response.end(
      JSON.stringify({
        object: "list",
        data: [{ id: model, object: "model", owned_by: "routekit-docker-e2e" }]
      })
    );
    return;
  }
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    let requested = model;
    try {
      const parsed = JSON.parse(body || "{}");
      if (typeof parsed.model === "string" && parsed.model.length > 0) {
        requested = parsed.model;
      }
    } catch {
      // Ignore malformed bodies; still return a completion.
    }
    response.end(
      JSON.stringify({
        id: "chatcmpl-docker-e2e",
        object: "chat.completion",
        model: requested,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "docker-e2e-ok" },
            finish_reason: "stop"
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    );
  });
});

server.listen(port, host, () => {
  process.stdout.write(`mock-provider listening on http://${host}:${port}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
