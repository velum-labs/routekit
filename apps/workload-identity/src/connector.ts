import { createServer } from "node:http";
import { GetWebIdentityTokenCommand, STSClient } from "@aws-sdk/client-sts";
import type { ConnectorConfig } from "./config.js";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

type Credential = { token: string; expiresAt: number };

function tokenExpiration(token: string): number {
  const claims = token.split(".")[1];
  if (claims === undefined) throw new Error("broker returned a malformed JWT");
  const parsed = JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as { exp?: unknown };
  if (!Number.isInteger(parsed.exp)) throw new Error("broker credential has no expiration");
  return parsed.exp as number;
}

async function requestBody(
  request: import("node:http").IncomingMessage
): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_REQUEST_BYTES) throw new Error("request body is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function startConnector(config: ConnectorConfig): Promise<{
  close(): Promise<void>;
  url: string;
}> {
  const sts = new STSClient({ region: config.region });
  let credential: Credential | undefined;
  let exchange: Promise<Credential> | undefined;
  const getCredential = async (): Promise<Credential> => {
    const now = Math.floor(Date.now() / 1000);
    if (credential !== undefined && credential.expiresAt > now + 30) return credential;
    if (exchange !== undefined) return await exchange;
    exchange = (async () => {
      const identity = await sts.send(
        new GetWebIdentityTokenCommand({
          Audience: [config.brokerAudience],
          DurationSeconds: config.credentialLifetimeSeconds,
          SigningAlgorithm: "ES384",
          Tags: [
            { Key: "trust-domain", Value: config.trustDomain },
            { Key: "routekit-principal", Value: config.routekitPrincipal }
          ]
        })
      );
      if (identity.WebIdentityToken === undefined)
        throw new Error("AWS STS returned no identity token");
      const response = await fetch(`${config.brokerUrl}/v1/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ assertion: identity.WebIdentityToken }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok)
        throw new Error(`credential broker rejected workload with HTTP ${response.status}`);
      const result = (await response.json()) as { access_token?: unknown; token_type?: unknown };
      if (typeof result.access_token !== "string" || result.token_type !== "Bearer") {
        throw new Error("credential broker returned an invalid response");
      }
      credential = { token: result.access_token, expiresAt: tokenExpiration(result.access_token) };
      return credential;
    })();
    try {
      return await exchange;
    } finally {
      exchange = undefined;
    }
  };

  // Fail startup when workload identity or broker authorization is broken.
  await getCredential();

  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "/";
      if (request.method === "GET" && path.split("?")[0] === "/connector-health") {
        await getCredential();
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store"
        });
        response.end('{"status":"ok"}');
        return;
      }
      const current = await getCredential();
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        const lower = name.toLowerCase();
        if (
          value === undefined ||
          HOP_BY_HOP.has(lower) ||
          lower === "host" ||
          lower === "authorization" ||
          lower === "x-api-key"
        ) {
          continue;
        }
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      headers.set("authorization", `Bearer ${current.token}`);
      const upstream = await fetch(`${config.routekitEndpoint}${path}`, {
        method: request.method ?? "GET",
        headers,
        body: await requestBody(request),
        signal: AbortSignal.timeout(10 * 60 * 1000)
      });
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name.toLowerCase())) responseHeaders[name] = value;
      });
      response.writeHead(upstream.status, responseHeaders);
      if (upstream.body === null) {
        response.end();
        return;
      }
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          if (part.value !== undefined && !response.write(Buffer.from(part.value))) {
            await new Promise<void>((resolve) => response.once("drain", resolve));
          }
        }
      } finally {
        reader.releaseLock();
      }
      response.end();
    })().catch((error: unknown) => {
      console.error(
        `workload connector request failed: ${error instanceof Error ? error.message : "unknown error"}`
      );
      if (!response.headersSent) {
        response.writeHead(503, {
          "content-type": "application/json",
          "cache-control": "no-store"
        });
        response.end('{"error":{"type":"unavailable","message":"workload connector unavailable"}}');
      } else {
        response.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    url: `http://${config.host}:${config.port}`,
    close: async () => await new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
