import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WorkloadJwtVerifierOptions } from "@velum-labs/routekit-gateway";
import type { ServiceRecord } from "@velum-labs/routekit-runtime/service";
import { CONTROL_PROTOCOL_VERSION, ControlClient } from "@velum-labs/routekit-runtime/control";
import { SERVICE_HOME_MODE } from "@velum-labs/routekit-runtime/service";
import { writeFileAtomic } from "@velum-labs/routekit-runtime/filesystem";
import {
  runRouteKitEffect,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

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

/** Filesystem adapter used by Effect control handlers. */
export function writeSnapshotEffect(
  home: string,
  category: "catalog" | "health",
  name: string,
  value: unknown
) {
  return Effect.try({
    try: () => writeSnapshot(home, category, name, value),
    catch: toRouteKitFailure
  });
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
