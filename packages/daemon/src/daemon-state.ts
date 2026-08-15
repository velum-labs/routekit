import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WorkloadJwtVerifierOptions } from "@velum-labs/routekit-gateway";
import type { ServiceRecord, TokenStore } from "@velum-labs/routekit-runtime";
import {
  CONTROL_PROTOCOL_VERSION,
  ControlClient,
  SERVICE_HOME_MODE,
  writeFileAtomic
} from "@velum-labs/routekit-runtime";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";

const WORKLOAD_JWT_CONFIG_ENV = "ROUTEKIT_WORKLOAD_JWT_CONFIG";

export function workloadJwtOptions(
  explicit: WorkloadJwtVerifierOptions | undefined,
  env: NodeJS.ProcessEnv
): WorkloadJwtVerifierOptions | undefined {
  if (explicit !== undefined) return explicit;
  const path = env[WORKLOAD_JWT_CONFIG_ENV];
  if (path === undefined || path.length === 0) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as WorkloadJwtVerifierOptions;
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${WORKLOAD_JWT_CONFIG_ENV} must contain a JSON object`);
  }
  return parsed;
}

export function resolveDataToken(
  home: string,
  input: { authToken?: string; authTokenFile?: string },
  tokens: TokenStore,
  dataTokenPath: (home: string) => string
): { token: string; path: string } {
  const path = input.authTokenFile ?? dataTokenPath(home);
  const ensured = tokens.ensureOwnerDataToken({
    ...(input.authToken !== undefined ? { plaintext: input.authToken } : {}),
    plaintextPath: path
  });
  if (ensured.token.length === 0) throw new Error("RouteKit data-plane token is empty");
  return { token: ensured.token, path };
}

export type DaemonPublicRecord = {
  product: string;
  kind: string;
  url: string;
  port: number;
  generation: number;
  protocolVersion: string;
  dataUrl?: string;
  dataPort?: number;
  startedAt: string;
};

export function daemonPublicRecordPath(home: string): string {
  return join(home, "services", "daemon.public.json");
}

export function writeDaemonPublicRecord(home: string, record: DaemonPublicRecord): void {
  const servicesDir = join(home, "services");
  mkdirSync(home, { recursive: true, mode: SERVICE_HOME_MODE });
  chmodSync(home, SERVICE_HOME_MODE);
  mkdirSync(servicesDir, { recursive: true, mode: SERVICE_HOME_MODE });
  chmodSync(servicesDir, SERVICE_HOME_MODE);
  const path = daemonPublicRecordPath(home);
  writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  chmodSync(path, 0o644);
}

export function removeDaemonPublicRecord(home: string): void {
  rmSync(daemonPublicRecordPath(home), { force: true });
}

export function dataTokenForPrincipal(
  tokens: TokenStore,
  cache: Map<string, string>,
  ownerToken: string,
  principal: { id: string; label: string; role: string } | undefined
): string {
  if (principal === undefined || principal.role === "ephemeral" || principal.role === "owner") {
    return ownerToken;
  }
  const label = `${principal.label}-data`;
  const cached = cache.get(label);
  if (cached !== undefined) return cached;
  const existing = tokens.findByLabel(label, "data");
  if (existing !== undefined) tokens.revoke(existing.id);
  const issued = tokens.issue({
    label,
    plane: "data",
    role: "admin",
    createdBy: principal.label
  });
  cache.set(label, issued.token);
  return issued.token;
}

export type RevisionState = { config: number; accounts: number; daemon: number };

function revisionPath(home: string): string {
  return join(home, "daemon-revisions.json");
}

export function readDaemonRevisions(home: string): RevisionState {
  try {
    const parsed = JSON.parse(readFileSync(revisionPath(home), "utf8")) as Partial<RevisionState>;
    return {
      config:
        typeof parsed.config === "number" && Number.isSafeInteger(parsed.config)
          ? parsed.config
          : 0,
      accounts:
        typeof parsed.accounts === "number" && Number.isSafeInteger(parsed.accounts)
          ? parsed.accounts
          : 0,
      daemon:
        typeof parsed.daemon === "number" && Number.isSafeInteger(parsed.daemon) ? parsed.daemon : 0
    };
  } catch {
    return { config: 0, accounts: 0, daemon: 0 };
  }
}

export function writeDaemonRevisions(home: string, revisions: RevisionState): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileAtomic(revisionPath(home), `${JSON.stringify(revisions, null, 2)}\n`, {
    mode: 0o600
  });
  chmodSync(revisionPath(home), 0o600);
}

export function writeSnapshot(
  home: string,
  category: "catalog" | "health",
  name: string,
  value: unknown
): void {
  const directory = join(home, category);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${name}.json`);
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function healthyControl(record: ServiceRecord): Promise<boolean> {
  if (record.controlToken === undefined) return false;
  try {
    const client = new ControlClient({
      url: record.url,
      token: record.controlToken,
      timeoutMs: 1_000
    });
    const health = await runRouteKitEffect(client.health());
    return health.protocol === CONTROL_PROTOCOL_VERSION;
  } catch {
    return false;
  }
}
