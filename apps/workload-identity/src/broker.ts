import { createServer } from "node:http";
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import type { BrokerAwsIssuer, BrokerConfig, BrokerWorkload } from "./config.js";
import {
  derToJoseEs256,
  type Jwk,
  unsignedRouteKitJwt,
  unverifiedAwsIdentityTokenTarget,
  verifyAwsIdentityToken
} from "./jwt.js";

const MAX_ASSERTION_BYTES = 64 * 1024;
const AWS_NAMESPACE = "https://sts.amazonaws.com/";

type JwksCache = { keys: Jwk[]; expiresAt: number };

async function body(request: import("node:http").IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_ASSERTION_BYTES) throw new Error("request body is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  const encoded = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store"
  });
  response.end(encoded);
}

function workloadFor(
  config: BrokerConfig,
  claims: ReturnType<typeof verifyAwsIdentityToken>,
  audience: string
): BrokerWorkload {
  const aws = claims[AWS_NAMESPACE];
  const workload = config.workloads.find(
    (entry) =>
      entry.roleArn === claims.sub &&
      entry.accountId === aws.aws_account &&
      (entry.awsAudiences === undefined || entry.awsAudiences.includes(audience)) &&
      (entry.sourceVpcId === undefined || entry.sourceVpcId === aws.ec2_instance_source_vpc) &&
      (entry.sourceRegion === undefined || entry.sourceRegion === aws.source_region)
  );
  if (workload === undefined) throw new Error("AWS workload identity is not authorized");
  if (aws.ec2_role_delivery !== undefined && aws.ec2_role_delivery !== "2.0") {
    throw new Error("AWS workload identity did not use IMDSv2 role delivery");
  }
  return workload;
}

export async function startBroker(config: BrokerConfig): Promise<{
  close(): Promise<void>;
  url: string;
}> {
  const kms = new KMSClient({ region: config.region });
  const jwks = new Map<string, JwksCache>();
  const keys = async (issuer: BrokerAwsIssuer, force = false): Promise<Jwk[]> => {
    const now = Date.now();
    const cached = jwks.get(issuer.issuer);
    if (!force && cached !== undefined && cached.expiresAt > now) return cached.keys;
    const jwksUri = issuer.jwksUri ?? `${issuer.issuer}/.well-known/jwks.json`;
    const response = await fetch(jwksUri, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`AWS JWKS request failed with HTTP ${response.status}`);
    const document = (await response.json()) as { keys?: unknown };
    if (!Array.isArray(document.keys) || document.keys.length === 0) {
      throw new Error("AWS JWKS response contains no keys");
    }
    const loaded = document.keys.filter(
      (entry): entry is Jwk =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { kid?: unknown }).kid === "string"
    );
    if (loaded.length === 0) throw new Error("AWS JWKS response has no usable keys");
    jwks.set(issuer.issuer, { keys: loaded, expiresAt: now + 5 * 60 * 1000 });
    return loaded;
  };

  // Do not advertise readiness until every configured issuer is reachable.
  await Promise.all(config.awsIssuers.map(async (issuer) => await keys(issuer)));

  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && path === "/health") {
        json(response, 200, { status: "ok" });
        return;
      }
      if (request.method !== "POST" || path !== "/v1/exchange") {
        json(response, 404, { error: "not_found" });
        return;
      }
      const parsed = JSON.parse((await body(request)).toString("utf8")) as { assertion?: unknown };
      if (typeof parsed.assertion !== "string" || parsed.assertion.length === 0) {
        json(response, 400, { error: "invalid_request" });
        return;
      }
      let claims: ReturnType<typeof verifyAwsIdentityToken>;
      const target = unverifiedAwsIdentityTokenTarget(parsed.assertion);
      const issuer = config.awsIssuers.find((entry) => entry.issuer === target.issuer);
      if (issuer === undefined) throw new Error("AWS workload identity issuer is not authorized");
      const audience = issuer.audiences.find((entry) => target.audiences.includes(entry));
      if (audience === undefined) throw new Error("AWS workload identity audience is not authorized");
      try {
        claims = verifyAwsIdentityToken({
          token: parsed.assertion,
          keys: await keys(issuer),
          issuer: issuer.issuer,
          audience,
          maxLifetimeSeconds: 300
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("signing key is unknown")) {
          claims = verifyAwsIdentityToken({
            token: parsed.assertion,
            keys: await keys(issuer, true),
            issuer: issuer.issuer,
            audience,
            maxLifetimeSeconds: 300
          });
        } else {
          throw error;
        }
      }
      const workload = workloadFor(config, claims, audience);
      const unsigned = unsignedRouteKitJwt({
        kid: config.kmsKeyVersion,
        issuer: config.routekitIssuer,
        audience: config.routekitAudience,
        subject: claims.sub,
        trustDomain: workload.trustDomain,
        routekitPrincipal: workload.routekitPrincipal,
        lifetimeSeconds: config.credentialLifetimeSeconds
      });
      const signed = await kms.send(
        new SignCommand({
          KeyId: config.kmsKeyId,
          Message: Buffer.from(unsigned.signingInput, "ascii"),
          MessageType: "RAW",
          SigningAlgorithm: "ECDSA_SHA_256"
        })
      );
      if (signed.Signature === undefined) throw new Error("KMS returned no signature");
      const credential = `${unsigned.signingInput}.${derToJoseEs256(signed.Signature).toString("base64url")}`;
      json(response, 200, {
        access_token: credential,
        token_type: "Bearer",
        expires_in: unsigned.expiresAt - Math.floor(Date.now() / 1000)
      });
    })().catch((error: unknown) => {
      console.error(
        `workload broker request failed: ${error instanceof Error ? error.message : "unknown error"}`
      );
      if (!response.headersSent) json(response, 401, { error: "invalid_identity" });
      else response.destroy();
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
