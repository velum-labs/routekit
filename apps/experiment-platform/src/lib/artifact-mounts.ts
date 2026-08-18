import path from "node:path";

import type { ExperimentJsonValue } from "@velum-labs/routekit-eval-contracts";
import type { Sandbox } from "@vercel/sandbox";

import { artifactReferenceFromPath } from "./artifact-reference";
import { getArtifactStore } from "./platform";

export type ExperimentArtifactMount = {
  artifact: string;
  path: string;
};

function safeRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized.includes("\0")
  ) {
    throw new Error(`unsafe artifact mount path ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function artifactMountsFromConfiguration(
  configuration: Readonly<Record<string, ExperimentJsonValue>>
): ExperimentArtifactMount[] {
  const raw = configuration.artifactMounts;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("artifactMounts must be an array");
  if (raw.length > 8) throw new Error("artifactMounts supports at most 8 artifacts per job");
  const seenPaths = new Set<string>();
  return raw.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error(`artifactMounts[${index}] must be an object`);
    }
    const artifact = candidate.artifact;
    const target = candidate.path;
    if (typeof artifact !== "string" || typeof target !== "string") {
      throw new Error(`artifactMounts[${index}] requires artifact and path strings`);
    }
    artifactReferenceFromPath(artifact);
    const normalized = safeRelativePath(target);
    if (seenPaths.has(normalized)) {
      throw new Error(`duplicate artifact mount path ${JSON.stringify(normalized)}`);
    }
    seenPaths.add(normalized);
    return { artifact, path: normalized };
  });
}

export async function materializeArtifactMounts(input: {
  sandbox: Sandbox;
  directory: string;
  configuration: Readonly<Record<string, ExperimentJsonValue>>;
}): Promise<Array<ExperimentArtifactMount & { absolutePath: string; size: number }>> {
  const mounts = artifactMountsFromConfiguration(input.configuration);
  if (mounts.length === 0) return [];
  const store = getArtifactStore();
  const materialized: Array<ExperimentArtifactMount & { absolutePath: string; size: number }> = [];
  for (const mount of mounts) {
    const bytes = await store.get(artifactReferenceFromPath(mount.artifact));
    const absolutePath = path.posix.join(input.directory, "mounts", mount.path);
    await input.sandbox.fs.mkdir(path.posix.dirname(absolutePath), { recursive: true });
    await input.sandbox.fs.writeFile(absolutePath, bytes);
    materialized.push({ ...mount, absolutePath, size: bytes.byteLength });
  }
  return materialized;
}
