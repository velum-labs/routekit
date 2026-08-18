#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLunaContextBudgetExposure,
  type LunaContextExposureProvenanceV1,
  type LunaNaturalLongContextEvidenceRequirementV1,
} from "./luna-accuracy-context-exposure.ts";
import {
  LUNA_ACCURACY_TASK_BUDGET_CHARACTER_CAPS,
  type LunaAccuracyRepositoryProfileDetail,
  type LunaAccuracyTaskBudget,
  type LunaAccuracyTaskFormat,
} from "./luna-accuracy-context.ts";
import { readJsonl } from "./jsonl.ts";
import type { RepositoryProfileV1, TaskEpisode } from "./types.ts";

const usage = `Usage:
  node --experimental-strip-types src/luna-accuracy-context-exposure-cli.ts \\
    --profile FILE --episodes FILE --output FILE \\
    [--provenance FILE] [--requirements FILE] \\
    [--task-format labeled_sections|chronological|compact_json] \\
    [--profile-detail identity|components|full] \\
    [--lower-budget 2k|6k|16k] [--higher-budget 6k|16k|32k]

This command is offline. It makes no model or network calls and writes a
private aggregate report containing no task text or raw per-case identifiers.
`;

const value = (args: readonly string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const found = args[index + 1];
  if (!found || found.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return found;
};

const required = (args: readonly string[], flag: string): string => {
  const found = value(args, flag);
  if (!found) throw new Error(`Missing required argument: ${flag}`);
  return found;
};

const taskFormat = (raw: string | undefined): LunaAccuracyTaskFormat => {
  const found = raw ?? "labeled_sections";
  if (
    found !== "labeled_sections" &&
    found !== "chronological" &&
    found !== "compact_json"
  ) {
    throw new Error(`Unsupported task format: ${found}`);
  }
  return found;
};

const profileDetail = (
  raw: string | undefined,
): LunaAccuracyRepositoryProfileDetail => {
  const found = raw ?? "components";
  if (
    found !== "identity" &&
    found !== "components" &&
    found !== "full"
  ) {
    throw new Error(`Unsupported profile detail: ${found}`);
  }
  return found;
};

const budget = (
  raw: string | undefined,
  fallback: LunaAccuracyTaskBudget,
): LunaAccuracyTaskBudget => {
  const found = raw ?? fallback;
  if (!(found in LUNA_ACCURACY_TASK_BUDGET_CHARACTER_CAPS)) {
    throw new Error(`Unsupported task budget: ${found}`);
  }
  return found as LunaAccuracyTaskBudget;
};

const writePrivateJson = async (
  file: string,
  valueToWrite: unknown,
): Promise<void> => {
  await mkdir(resolve(file, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(
    temporary,
    `${JSON.stringify(valueToWrite, null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, file);
};

export const runLunaContextExposureCli = async (
  args: readonly string[],
): Promise<void> => {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage);
    return;
  }
  const profileFile = resolve(required(args, "--profile"));
  const episodesFile = resolve(required(args, "--episodes"));
  const output = resolve(required(args, "--output"));
  const provenanceFile = value(args, "--provenance");
  const requirementsFile = value(args, "--requirements");

  const profile = JSON.parse(
    await readFile(profileFile, "utf8"),
  ) as RepositoryProfileV1;
  const episodes = await readJsonl<TaskEpisode>(episodesFile);
  const provenance = provenanceFile
    ? await readJsonl<LunaContextExposureProvenanceV1>(
      resolve(provenanceFile),
    )
    : [];
  const evidenceRequirements = requirementsFile
    ? await readJsonl<LunaNaturalLongContextEvidenceRequirementV1>(
      resolve(requirementsFile),
    )
    : [];

  const report = auditLunaContextBudgetExposure({
    episodes,
    profile,
    taskFormat: taskFormat(value(args, "--task-format")),
    profileDetail: profileDetail(value(args, "--profile-detail")),
    lowerBudget: budget(value(args, "--lower-budget"), "6k"),
    higherBudget: budget(value(args, "--higher-budget"), "32k"),
    provenance,
    evidenceRequirements,
  });
  await writePrivateJson(output, report);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      output,
      externalCallsMade: 0,
      episodes: report.dataset.episodes,
      differentSerializedContexts:
        report.comparison.differentSerializedContexts,
      recallQualifiedIndependentLineages:
        report.evidenceRequirements
          .independentLineagesWithAllDecisiveEvidenceAtHigherAndAtLeastOneMissingAtLower,
      claimScope: report.claimScope,
    }, null, 2)}\n`,
  );
};

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  runLunaContextExposureCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${String(error)}\n\n${usage}`);
    process.exitCode = 1;
  });
}
