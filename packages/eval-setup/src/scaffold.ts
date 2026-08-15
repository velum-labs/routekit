import {
  assertRoutingProfile,
  EVAL_CONTRACT_VERSION,
  type RoutingProfile
} from "@velum-labs/routekit-eval-contracts";
import { Context, Effect, FileSystem, Layer, Path } from "effect";

import { EvalSetupScaffoldError } from "./errors.js";
import type { ScaffoldInput, ScaffoldResult } from "./types.js";

export type EvalSetupScaffolderShape = {
  readonly scaffold: (
    input: ScaffoldInput
  ) => Effect.Effect<ScaffoldResult, EvalSetupScaffoldError>;
};

export class EvalSetupScaffolder extends Context.Service<
  EvalSetupScaffolder,
  EvalSetupScaffolderShape
>()("@velum-labs/routekit-eval-setup/EvalSetupScaffolder") {}

const safeProfileId = (profileId: string): boolean => /^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(profileId);

const scaffoldFailure = (path: string, cause: unknown): EvalSetupScaffoldError =>
  new EvalSetupScaffoldError({
    path,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause
  });

const yamlString = (value: string): string => JSON.stringify(value);

const profileYaml = (profile: RoutingProfile): string => {
  const eligibility = Object.entries(profile.eligibility)
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([key, value]) => `  ${key}: ${String(value)}`);
  return `${[
    `version: ${profile.version}`,
    `id: ${yamlString(profile.id)}`,
    `suite: ${yamlString(profile.suite)}`,
    "candidates:",
    ...profile.candidates.map((model) => `  - ${yamlString(model)}`),
    `judge: ${yamlString(profile.judge)}`,
    "eligibility:",
    ...(eligibility.length === 0 ? ["  {}"] : eligibility),
    `objective: ${yamlString(profile.objective)}`
  ].join("\n")}\n`;
};

const evalSource = (input: ScaffoldInput): string => `import assert from "node:assert/strict";
import { test } from "node:test";
import { setupAgent, setupJudge } from "routekit/eval";

const candidates = ${JSON.stringify(input.candidates, null, 2)} as const;
const judge = setupJudge({
  agent: setupAgent({ model: ${JSON.stringify(input.judgeModel)} }),
  minScore: 0.8,
});

const cases = [
  {
    id: "replace-with-real-case",
    prompt: ${JSON.stringify(`Replace with representative input for ${input.surface}.`)},
  },
] as const;

for (const model of candidates) {
  for (const testCase of cases) {
    test(\`\${model} / \${testCase.id}\`, async () => {
      const run = await setupAgent({ model }).run(testCase.prompt);
      run.toComplete();
      assert.ok(run.text.trim().length > 0, "candidate returned empty text");
      await judge.autoEvals({
        criteria: ${JSON.stringify(input.criteria)},
        prompt: testCase.prompt,
        run,
      });
    });
  }
}
`;

export const scaffoldEvalRoutingProfile = Effect.fn("EvalSetup.scaffold")(function* (
  input: ScaffoldInput
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  if (!safeProfileId(input.profileId)) {
    return yield* new EvalSetupScaffoldError({
      path: input.repositoryRoot,
      detail: `invalid profile id ${JSON.stringify(input.profileId)}`
    });
  }
  const evalDirectory = paths.join(input.repositoryRoot, ".routekit", "evals", input.profileId);
  const routingDirectory = paths.join(input.repositoryRoot, ".routekit", "routing");
  const evalPath = paths.join(evalDirectory, `${input.profileId}.eval.ts`);
  const profilePath = paths.join(routingDirectory, `${input.profileId}.yaml`);
  const suitePath = paths.relative(input.repositoryRoot, evalPath).split(paths.sep).join("/");
  const profile: RoutingProfile = {
    version: EVAL_CONTRACT_VERSION,
    id: input.profileId,
    suite: suitePath,
    candidates: [...input.candidates],
    judge: input.judgeModel,
    eligibility: { minimumPassRate: 0.8 },
    objective: input.objective
  };
  yield* Effect.try({
    try: () => assertRoutingProfile(profile),
    catch: (cause) => scaffoldFailure(profilePath, cause)
  });
  yield* fs
    .makeDirectory(evalDirectory, { recursive: true })
    .pipe(Effect.mapError((cause) => scaffoldFailure(evalDirectory, cause)));
  yield* fs
    .makeDirectory(routingDirectory, { recursive: true })
    .pipe(Effect.mapError((cause) => scaffoldFailure(routingDirectory, cause)));
  yield* fs
    .writeFileString(evalPath, evalSource(input))
    .pipe(Effect.mapError((cause) => scaffoldFailure(evalPath, cause)));
  yield* fs
    .writeFileString(profilePath, profileYaml(profile))
    .pipe(Effect.mapError((cause) => scaffoldFailure(profilePath, cause)));
  return { evalPath, profilePath, profile } satisfies ScaffoldResult;
});

export const EvalSetupScaffolderLive = Layer.effect(
  EvalSetupScaffolder,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    return EvalSetupScaffolder.of({
      scaffold: (input) =>
        scaffoldEvalRoutingProfile(input).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, paths)
        )
    });
  })
);
