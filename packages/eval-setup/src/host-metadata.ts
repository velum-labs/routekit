import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RoutingObjective } from "@velum-labs/routekit-eval-contracts";
import type { OriEvalResult } from "./ori-result.js";

export type HostEligibility = {
  readonly minimumPassRate: number;
  readonly minimumJudgeScore: number;
};

export type EvalHostMetadata = {
  readonly version: 1;
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly description?: string;
  readonly objective: RoutingObjective;
  readonly eligibility: HostEligibility;
  readonly revision: number;
  readonly updatedAt: string;
  readonly answers: Record<string, string>;
  readonly runDirectory?: string;
  readonly scratchWorkspace?: string;
  readonly lastResult?: OriEvalResult;
  readonly publishApproved?: boolean;
};

const HOST_FILE = "host.json";

export const hostDirectory = (repositoryRoot: string, profileId: string): string =>
  path.join(repositoryRoot, ".routekit", "eval-setup", profileId);

export const authoringRequest = (profileId: string, objective: RoutingObjective): string =>
  [
    `Author a RouteKit eval-driven routing suite for profile "${profileId}".`,
    "Use the create-eval skill unchanged.",
    "Keep Ori's five-candidate and 10-15-case defaults.",
    `Host objective: ${objective}.`,
    "Do not mutate the user's repository; write the suite in the scratch workspace."
  ].join(" ");

export const initialHostMetadata = (input: {
  readonly profileId: string;
  readonly repositoryRoot: string;
  readonly now: string;
  readonly objective?: RoutingObjective;
  readonly description?: string;
}): EvalHostMetadata => ({
  version: 1,
  profileId: input.profileId,
  repositoryRoot: input.repositoryRoot,
  ...(input.description === undefined ? {} : { description: input.description }),
  objective: input.objective ?? "lowest-cost",
  eligibility: { minimumPassRate: 0.8, minimumJudgeScore: 0.8 },
  revision: 0,
  updatedAt: input.now,
  answers: {}
});

export const loadHostMetadata = async (
  repositoryRoot: string,
  profileId: string
): Promise<EvalHostMetadata | undefined> => {
  try {
    const raw = JSON.parse(
      await readFile(path.join(hostDirectory(repositoryRoot, profileId), HOST_FILE), "utf8")
    ) as EvalHostMetadata;
    if (raw.version !== 1 || raw.profileId !== profileId) return undefined;
    return raw;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
};

export const saveHostMetadata = async (metadata: EvalHostMetadata): Promise<void> => {
  const directory = hostDirectory(metadata.repositoryRoot, metadata.profileId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, HOST_FILE), `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
};
