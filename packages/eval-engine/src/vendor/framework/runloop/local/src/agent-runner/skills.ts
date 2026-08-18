import { Effect } from "effect";

import type { FeatureLogger } from "../../../../contracts/author/src/index.ts";
import type { SkillRegistryEntry } from "../../../../contracts/internal/src/author-schemas/skill.ts";
import type { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import type { AgentRunnerCommand } from "./service.ts";
import type { FeatureCatalog } from "../catalog/feature.ts";
import type {
  HarnessWorkspace,
  HarnessWorkspaceMaterializerShape,
} from "../harness-workspace/index.ts";

import { isPackedInternEnv } from "../../../../contracts/internal/src/cli/intern-launcher-env.ts";
import { prepareAndLogWorkspace } from "../harness-workspace/index.ts";
import { ContextWindowLookup } from "../models/context-window.ts";

export const warnOnCodeSkillCollisions = (input: {
  readonly catalog: FeatureCatalog["Service"];
  readonly diagnosticsLogger: FeatureLogger;
  readonly env: NodeJS.ProcessEnv;
  readonly skills: readonly SkillRegistryEntry[];
}): readonly SkillRegistryEntry[] => {
  const { catalog, diagnosticsLogger, env, skills } = input;
  if (isPackedInternEnv(env)) {
    return skills;
  }
  for (const skill of skills) {
    if (catalog.workspaceSkillNames.includes(skill.name)) {
      diagnosticsLogger.warn(
        `global skill "${skill.name}" conflicts with built-in ori code skill "${skill.name}"; the global skill wins`
      );
    }
  }
  return skills;
};

export const skillsForCodeWorkspace = Effect.fn(
  "AgentRunner.skillsForCodeWorkspace"
)(function* (input: {
  readonly catalog: FeatureCatalog["Service"];
  readonly diagnosticsLogger: FeatureLogger;
  readonly hostProcess: HostProcess["Service"];
  readonly skills: readonly SkillRegistryEntry[];
}) {
  const { catalog, diagnosticsLogger, hostProcess, skills } = input;
  const env = yield* hostProcess.env;
  if (isPackedInternEnv(env)) {
    return skills;
  }
  const workspaceSkills = warnOnCodeSkillCollisions({
    catalog,
    diagnosticsLogger,
    env,
    skills,
  });
  const globalSkillNames = new Set(workspaceSkills.map((skill) => skill.name));
  return [
    ...workspaceSkills,
    ...(yield* catalog.resolveWorkspaceSkills(globalSkillNames)),
  ];
});

export const resolveExtraSkillDirs = Effect.fn(
  "AgentRunner.resolveExtraSkillDirs"
)(function* (hostProcess: HostProcess["Service"], workspace: HarnessWorkspace) {
  const env = yield* hostProcess.env;
  if (isPackedInternEnv(env)) {
    return;
  }
  return workspace.nativeSkillDir === undefined
    ? []
    : [workspace.nativeSkillDir];
});

export const resolveHarnessContextWindow = Effect.fn(
  "AgentRunner.resolveHarnessContextWindow"
)(function* (
  model: string | null | undefined,
  defaultModel: string | undefined
) {
  return yield* (yield* ContextWindowLookup).lookup(model ?? defaultModel);
});

export const prepareHarnessWorkspace = Effect.fn(
  "AgentRunner.prepareHarnessWorkspace"
)(function* (input: {
  readonly bootSkills: readonly SkillRegistryEntry[];
  readonly command: AgentRunnerCommand;
  readonly defaultModel: string | undefined;
  readonly diagnosticsLogger: FeatureLogger;
  readonly catalog: FeatureCatalog["Service"];
  readonly hostProcess: HostProcess["Service"];
  readonly materializer: HarnessWorkspaceMaterializerShape;
  readonly model: string | null | undefined;
  readonly workspaceFeatureIds: readonly string[];
}) {
  const { bootSkills, command, hostProcess, model } = input;
  const env = yield* hostProcess.env;
  const skills = yield* skillsForCodeWorkspace({
    catalog: input.catalog,
    diagnosticsLogger: input.diagnosticsLogger,
    hostProcess,
    skills: bootSkills,
  });
  const workspace = yield* prepareAndLogWorkspace(
    input.materializer,
    hostProcess,
    {
      cwd: command.cwd,
      diagnosticsLogger: input.diagnosticsLogger,
      featuresRoot: command.featuresRoot,
      harnessName: command.harnessName,
      model,
      skills,
      workspaceFeatureIds: input.workspaceFeatureIds,
    }
  );
  const contextWindow = yield* resolveHarnessContextWindow(
    model,
    input.defaultModel
  );
  const extraSkillDirs = yield* resolveExtraSkillDirs(hostProcess, workspace);
  return {
    contextWindow,
    env,
    extraSkillDirs,
    workspace,
  };
});
