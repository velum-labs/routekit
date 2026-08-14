/**
 * ACP Registry integration. Resolves curated ACP-compatible agents (for
 * example the registry-backed `Codex CLI` and `Claude Agent` adapters) from the
 * ACP Registry so they can drive the generic ACP front door. The install
 * directory is injectable for deterministic testing.
 *
 * Registry source: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  executeWebRequest,
  RouteKitFailure,
  routeKitError,
  toRouteKitFailure
} from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";
import { HttpClient } from "effect/unstable/http";
import { gatewayTry } from "./effect/gateway.js";

export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export type AcpRegistryAgent = {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  distribution?: Record<string, unknown>;
};

export type AcpRegistry = {
  agents: AcpRegistryAgent[];
};

export type InstalledAcpAdapter = {
  id: string;
  name: string;
  version: string;
  distribution: Record<string, unknown>;
  installedAt: string;
  metadataPath: string;
};

function normalizeRegistry(raw: unknown): AcpRegistry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("ACP registry payload must be an object");
  }
  const agentsValue = (raw as { agents?: unknown }).agents;
  if (!Array.isArray(agentsValue)) {
    throw new Error("ACP registry payload is missing an agents array");
  }
  const agents: AcpRegistryAgent[] = [];
  for (const entry of agentsValue) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    const agent: AcpRegistryAgent = { id };
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string") agent.name = name;
    const version = (entry as { version?: unknown }).version;
    if (typeof version === "string") agent.version = version;
    const description = (entry as { description?: unknown }).description;
    if (typeof description === "string") agent.description = description;
    const distribution = (entry as { distribution?: unknown }).distribution;
    if (typeof distribution === "object" && distribution !== null) {
      agent.distribution = distribution as Record<string, unknown>;
    }
    agents.push(agent);
  }
  return { agents };
}

export function fetchAcpRegistry(
  url: string = ACP_REGISTRY_URL
): Effect.Effect<AcpRegistry, Error, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const response = yield* executeWebRequest(url).pipe(
      Effect.mapError((error) => routeKitError(error))
    );
    if (!response.ok) {
      return yield* new RouteKitFailure({
        message: `ACP registry fetch failed: ${response.status}`
      });
    }
    const payload = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) => toRouteKitFailure(cause)
    });
    return normalizeRegistry(payload);
  });
}

export type InstallAcpAdaptersOptions = {
  agentIds: string[];
  installDir: string;
  url?: string;
};

export function installAcpAdapters(
  options: InstallAcpAdaptersOptions
): Effect.Effect<InstalledAcpAdapter[], Error, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    if (options.agentIds.length === 0) {
      return yield* new RouteKitFailure({ message: "at least one ACP agent id is required" });
    }
    const registry = yield* fetchAcpRegistry(options.url ?? ACP_REGISTRY_URL);
    const byId = new Map(registry.agents.map((agent) => [agent.id, agent]));
    const dir = resolve(options.installDir);
    yield* gatewayTry(() => mkdirSync(dir, { recursive: true }));

    const installed: InstalledAcpAdapter[] = [];
    for (const agentId of options.agentIds) {
      const agent = byId.get(agentId);
      if (agent === undefined) {
        return yield* new RouteKitFailure({
          message: `ACP registry has no agent with id "${agentId}"`
        });
      }
      if (agent.distribution === undefined) {
        return yield* new RouteKitFailure({
          message: `ACP agent "${agentId}" has no distribution metadata`
        });
      }
      const metadataPath = join(dir, `${agentId}.json`);
      const record: InstalledAcpAdapter = {
        id: agent.id,
        name: agent.name ?? agent.id,
        version: agent.version ?? "unknown",
        distribution: agent.distribution,
        installedAt: new Date().toISOString(),
        metadataPath
      };
      yield* gatewayTry(() => writeFileSync(metadataPath, JSON.stringify(record, null, 2) + "\n"));
      installed.push(record);
    }
    return installed;
  });
}
