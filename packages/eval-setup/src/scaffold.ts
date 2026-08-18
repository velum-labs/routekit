import {
  assertRoutingProfile,
  EVAL_CONTRACT_VERSION,
  type RoutingProfile
} from "@velum-labs/routekit-eval-contracts";
import { Context, Effect, FileSystem, Layer, Path } from "effect";

import { EvalSetupScaffoldError } from "./errors.js";
import { assertEvalModelSelection } from "./model-selection.js";
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

const safeProfileId = (profileId: string): boolean =>
  /^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(profileId);

const scaffoldFailure = (path: string, cause: unknown): EvalSetupScaffoldError =>
  new EvalSetupScaffoldError({
    path,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause
  });

const CASE_SOURCE_BYTES = 8 * 1024;

export type ScaffoldCase = {
  readonly id: string;
  readonly prompt: string;
  readonly context: string;
  readonly rubric: string;
};

const yamlString = (value: string): string => JSON.stringify(value);

const seedCases = (input: ScaffoldInput): readonly ScaffoldCase[] => [
  {
    id: "representative-request",
    prompt: `Complete a representative ${input.surface} request accurately and completely.`,
    context: `Workflow: ${input.surface}\nAvailable input source: ${input.dataSource}`,
    rubric: `The response must complete the requested workflow and satisfy: ${input.criteria}`
  },
  {
    id: "missing-context",
    prompt: `A ${input.surface} request is missing important context. Identify the blocker and ask for only the information required to continue.`,
    context: `Workflow: ${input.surface}\nThe supplied request is intentionally incomplete.`,
    rubric:
      "The response must identify the concrete missing information without inventing facts or requesting unrelated details."
  },
  {
    id: "constraint-boundary",
    prompt: `Handle a difficult ${input.surface} request while preserving correctness under the stated constraint.`,
    context: `Workflow: ${input.surface}\nConstraint: ${input.constraint}`,
    rubric: `The response must satisfy ${input.criteria}; optimization must not weaken correctness.`
  }
];

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "section";

export const parseDataSourcePath = (dataSource: string): string | undefined => {
  const trimmed = dataSource.trim();
  if (trimmed.length === 0 || /generate seed cases/iu.test(trimmed)) return undefined;
  const withKind =
    /^(.*)\s+\((doc|prompt|dataset|fixture|test|schema)\)$/u.exec(trimmed)?.[1] ?? trimmed;
  const candidate = withKind.trim();
  if (candidate.includes("/") || /\.\w+$/u.test(candidate)) return candidate;
  return undefined;
};

const fileStem = (relativePath: string): string => {
  const base = relativePath.split(/[\\/]/u).at(-1) ?? relativePath;
  return base.replace(/\.[^.]+$/u, "");
};

type Excerpt = {
  readonly heading: string;
  readonly body: string;
};

const markdownSections = (text: string): Excerpt[] => {
  const matches = [...text.matchAll(/^##\s+(.+)$/gmu)];
  if (matches.length === 0) return [];
  const sections: Excerpt[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (match === undefined) continue;
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    const raw = text.slice(start, end).trim();
    const heading = match[1]?.trim() || `section ${String(index + 1)}`;
    const afterHeading = raw.split(/\n+/u).slice(1).join("\n").trim();
    if (afterHeading.length === 0) continue;
    sections.push({ heading, body: raw.slice(0, 800) });
  }
  return sections;
};

const textChunks = (text: string, count: number): Excerpt[] => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const size = Math.max(1, Math.ceil(trimmed.length / count));
  const chunks: Excerpt[] = [];
  for (let index = 0; index < count; index += 1) {
    const slice = trimmed.slice(index * size, (index + 1) * size).trim();
    if (slice.length === 0) continue;
    chunks.push({ heading: `part ${String(index + 1)}`, body: slice.slice(0, 800) });
  }
  return chunks;
};

const excerptCases = (relativePath: string, text: string): readonly ScaffoldCase[] => {
  const sections = markdownSections(text);
  const excerpts = sections.length >= 3 ? sections.slice(0, 3) : textChunks(text, 3);
  const used = new Set<string>();
  return excerpts.map((excerpt) => {
    const base = slug(`${fileStem(relativePath)}-${excerpt.heading}`);
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${String(suffix)}`;
      suffix += 1;
    }
    used.add(id);
    return {
      id,
      prompt: `Explain how a user should apply the "${excerpt.heading}" section to complete the documented workflow. Include concrete actions and important constraints.`,
      context: `Source: ${relativePath}\n\n${excerpt.body}`,
      rubric: `The response must accurately apply the "${excerpt.heading}" section, include its actionable details, and introduce no unsupported claims.`
    };
  });
};

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

const evalSource = (
  input: ScaffoldInput,
  cases: readonly ScaffoldCase[]
): string => `import assert from "node:assert/strict";
import { test } from "node:test";
import { setupAgent, setupJudge } from "routekit/eval";

const candidateModels = ${JSON.stringify(input.candidates, null, 2)} as const;
const judge = setupJudge({
  agent: setupAgent({ model: ${JSON.stringify(input.judgeModel)} }),
  minScore: 0.8,
});

const cases = ${JSON.stringify(cases, null, 2)} as const;

for (const model of candidateModels) {
  const candidate = setupAgent({ model });
  for (const testCase of cases) {
    test(\`\${model} / \${testCase.id}\`, async () => {
      const candidatePrompt = [
        testCase.prompt,
        "",
        "Reference material:",
        "-----",
        testCase.context,
        "-----",
      ].join("\\n");
      const run = await candidate.run(candidatePrompt);
      run.toComplete();
      assert.ok(run.text.trim().length > 0, "candidate returned empty text");
      await judge.autoEvals({
        criteria: [
          ${JSON.stringify(input.criteria)},
          "",
          "Case-specific rubric:",
          testCase.rubric,
          "Reject unsupported claims and answers that omit required facts.",
        ].join("\\n"),
        prompt: candidatePrompt,
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
    // A generated policy is only publishable when a candidate demonstrates
    // consistently passing, high-quality evidence. With a three-case pilot,
    // this deliberately requires all three cases to pass.
    eligibility: {
      minimumPassRate: 0.8,
      minimumJudgeScore: 0.8
    },
    objective: input.objective
  };
  yield* Effect.try({
    try: () => {
      assertEvalModelSelection(input.candidates, input.judgeModel);
      assertRoutingProfile(profile);
    },
    catch: (cause) => scaffoldFailure(profilePath, cause)
  });
  yield* fs
    .makeDirectory(evalDirectory, { recursive: true })
    .pipe(Effect.mapError((cause) => scaffoldFailure(evalDirectory, cause)));
  yield* fs
    .makeDirectory(routingDirectory, { recursive: true })
    .pipe(Effect.mapError((cause) => scaffoldFailure(routingDirectory, cause)));
  let cases = seedCases(input);
  const sourcePath = parseDataSourcePath(input.dataSource);
  if (sourcePath !== undefined) {
    const absolute = paths.resolve(input.repositoryRoot, sourcePath);
    const relative = paths.relative(input.repositoryRoot, absolute);
    const escapes =
      relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative);
    const exists = escapes
      ? false
      : yield* fs.exists(absolute).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      const raw = yield* fs
        .readFileString(absolute)
        .pipe(Effect.mapError((cause) => scaffoldFailure(absolute, cause)));
      const extracted = excerptCases(sourcePath, raw.slice(0, CASE_SOURCE_BYTES));
      if (extracted.length > 0) cases = extracted;
    }
  }
  yield* fs
    .writeFileString(evalPath, evalSource(input, cases))
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
