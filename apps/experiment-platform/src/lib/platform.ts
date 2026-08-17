import { join } from "node:path";

import {
  LocalArtifactStore,
  LocalExperimentLedger,
  VercelBlobArtifactStore,
  type ArtifactStore,
  type ExperimentLedger
} from "@velum-labs/routekit-eval-store/platform";

import { NeonExperimentLedger } from "./neon-ledger";

declare global {
  var routeKitExperimentLedger: ExperimentLedger | undefined;
  var routeKitArtifactStore: ArtifactStore | undefined;
}

function localRoot(): string {
  return process.env.EXPERIMENT_PLATFORM_LOCAL_ROOT ?? join(process.cwd(), ".routekit-experiments");
}

export async function getExperimentLedger(): Promise<ExperimentLedger> {
  if (globalThis.routeKitExperimentLedger !== undefined) {
    return globalThis.routeKitExperimentLedger;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (process.env.VERCEL === "1" && (databaseUrl === undefined || databaseUrl.length === 0)) {
    throw new Error("DATABASE_URL is required on Vercel; ephemeral local ledgers are disabled");
  }
  const ledger =
    databaseUrl === undefined || databaseUrl.length === 0
      ? new LocalExperimentLedger(join(localRoot(), "ledger.json"))
      : new NeonExperimentLedger(databaseUrl);
  await ledger.initialize();
  globalThis.routeKitExperimentLedger = ledger;
  return ledger;
}

export function getArtifactStore(): ArtifactStore {
  if (globalThis.routeKitArtifactStore !== undefined) return globalThis.routeKitArtifactStore;
  const hasBlobToken =
    (process.env.BLOB_READ_WRITE_TOKEN?.length ?? 0) > 0 ||
    ((process.env.VERCEL_OIDC_TOKEN?.length ?? 0) > 0 &&
      (process.env.BLOB_STORE_ID?.length ?? 0) > 0);
  if (process.env.VERCEL === "1" && !hasBlobToken) {
    throw new Error("Vercel Blob credentials are required on Vercel; local artifacts are disabled");
  }
  const store = hasBlobToken
    ? new VercelBlobArtifactStore()
    : new LocalArtifactStore(join(localRoot(), "artifacts"));
  globalThis.routeKitArtifactStore = store;
  return store;
}

export function platformConfiguration(): {
  mode: string;
  ledger: "local" | "neon";
  artifacts: "local" | "vercel-blob";
  productionReady: boolean;
  missingProductionConfiguration: string[];
} {
  const ledger = process.env.DATABASE_URL ? "neon" : "local";
  const artifacts =
    process.env.BLOB_READ_WRITE_TOKEN ||
    (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID)
      ? "vercel-blob"
      : "local";
  const missingProductionConfiguration = [
    ...(ledger === "neon" ? [] : ["DATABASE_URL"]),
    ...(artifacts === "vercel-blob" ? [] : ["Vercel Blob credentials"]),
    ...(process.env.EXPERIMENT_PLATFORM_API_TOKEN ? [] : ["EXPERIMENT_PLATFORM_API_TOKEN"]),
    ...(process.env.EXPERIMENT_PLATFORM_DASHBOARD_USER
      ? []
      : ["EXPERIMENT_PLATFORM_DASHBOARD_USER"]),
    ...(process.env.EXPERIMENT_PLATFORM_DASHBOARD_PASSWORD
      ? []
      : ["EXPERIMENT_PLATFORM_DASHBOARD_PASSWORD"])
  ];
  return {
    mode: `${ledger} + ${artifacts}`,
    ledger,
    artifacts,
    productionReady: missingProductionConfiguration.length === 0,
    missingProductionConfiguration
  };
}
