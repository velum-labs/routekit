import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { RoutingProfile } from "@velum-labs/routekit-eval-contracts";
import { Effect } from "effect";

import type { CompletedOriLibraryResult, OriStructuredEvalRun } from "../ori-artifact-promotion.js";
import {
  promoteOriAuthoredArtifacts,
  promoteOriEvalArtifacts,
  publishOriEvalPolicyHandoff,
  selectLatestSuccessfulOriEvalRun
} from "../ori-artifact-promotion.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const exists = async (target: string): Promise<boolean> =>
  stat(target)
    .then(() => true)
    .catch(() => false);

const makeRoot = async (label: string): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), label));
  roots.push(root);
  return root;
};

const structuredRows = (cutOff = false): OriStructuredEvalRun["results"] => [
  {
    model: "openai/cheap",
    role: "candidate",
    runKey: "cheap-1",
    durationMs: 25,
    terminal: {
      type: "turn.completed",
      payload: { usage: { costUsd: 0.001, inputTokens: 10, outputTokens: 5 } }
    },
    cutOff,
    outcome: cutOff ? "unknown" : "passed",
    score: cutOff ? undefined : 0.9
  },
  {
    model: "anthropic/strong",
    role: "candidate",
    runKey: "strong-1",
    cutOff: false,
    outcome: "passed",
    score: 0.95
  },
  {
    model: "openai/judge",
    role: "judge",
    runKey: "judge-1",
    durationMs: 12,
    cutOff: false,
    outcome: "passed"
  }
];

const runFor = (
  scratch: string,
  suite: string,
  options: {
    readonly cutOff?: boolean;
    readonly exitCode?: number;
    readonly finishedAt?: string;
  } = {}
): OriStructuredEvalRun => ({
  exitCode: options.exitCode ?? 0,
  files: [suite],
  results: structuredRows(options.cutOff),
  tests: [
    { name: "cheap case", status: "pass" },
    { name: "strong case", status: "pass" }
  ],
  workingDirectory: scratch,
  startedAt: "2026-08-16T00:00:00.000Z",
  finishedAt: options.finishedAt ?? "2026-08-16T00:01:00.000Z"
});

const completedResult = (
  scratch: string,
  evalRuns: readonly OriStructuredEvalRun[]
): CompletedOriLibraryResult => ({
  ok: true,
  status: "completed",
  scratchWorkspace: scratch,
  evalRuns
});

const profile = (eligibility: RoutingProfile["eligibility"] = {}): RoutingProfile => ({
  version: 1,
  id: "support",
  suite: "support.eval.ts",
  candidates: ["openai/cheap", "anthropic/strong"],
  judge: "openai/judge",
  eligibility,
  objective: "lowest-cost",
  description: "Customer support policy tasks"
});

const writeValidSuite = async (scratch: string): Promise<string> => {
  const suite = path.join(scratch, "support.eval.ts");
  await mkdir(path.join(scratch, "data"), { recursive: true });
  await writeFile(
    suite,
    [
      'import { readFile } from "node:fs/promises";',
      'import { test } from "node:test";',
      'import { label } from "./support.ts";',
      'const cases = JSON.parse(await readFile(new URL("./data/cases.json", import.meta.url), "utf8"));',
      'test(`${label} ${cases.length}`, () => { throw new Error("eval body must not rerun"); });'
    ].join("\n")
  );
  await writeFile(path.join(scratch, "support.ts"), 'export const label = "support";\n');
  await writeFile(path.join(scratch, "data", "cases.json"), '[{"prompt":"help"}]\n');
  await writeFile(path.join(scratch, "unreferenced.txt"), "do not promote\n");
  return suite;
};

test("promotes only measured evals and referenced support before publishing structured evidence", async () => {
  const root = await makeRoot("routekit-ori-handoff-");
  const repository = path.join(root, "repository");
  const scratch = path.join(root, "scratch");
  await Promise.all([mkdir(repository), mkdir(scratch)]);
  const suite = await writeValidSuite(scratch);
  const existing = path.join(repository, ".routekit", "evals", "support");
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, "stale.txt"), "old\n");
  const snapshotRoot = path.join(repository, ".routekit", "published");

  const outcome = await Effect.runPromise(
    publishOriEvalPolicyHandoff({
      profile: profile({ minimumPassRate: 1 }),
      repositoryRoot: repository,
      result: completedResult(scratch, [runFor(scratch, suite)]),
      snapshotRoot
    })
  );

  assert.equal(outcome.policy.selectedModel, "openai/cheap");
  assert.deepEqual(
    outcome.supportFiles.map((file) => path.relative(outcome.directory, file)),
    ["data/cases.json", "support.ts"]
  );
  assert.equal(await exists(path.join(outcome.directory, "unreferenced.txt")), false);
  assert.equal(await exists(path.join(outcome.directory, "stale.txt")), false);
  assert.equal(
    await readFile(path.join(outcome.directory, "data", "cases.json"), "utf8"),
    '[{"prompt":"help"}]\n'
  );
  const strong = outcome.comparison.models.find((entry) => entry.model === "anthropic/strong");
  assert.deepEqual(strong?.cases[0]?.measurement, { judgeScore: 0.95 });
  const snapshot = JSON.parse(
    await readFile(path.join(snapshotRoot, "published-routing.v1.json"), "utf8")
  ) as { profiles: Record<string, { selectedModel: string }> };
  assert.equal(snapshot.profiles.support?.selectedModel, "openai/cheap");
  assert.match(
    await readFile(path.join(repository, ".routekit", "routing", "support.yaml"), "utf8"),
    /description: Customer support policy tasks/u
  );
});

test("promotes artifact-only author output to canonical eval and routing paths", async () => {
  const root = await makeRoot("routekit-ori-authored-");
  const repository = path.join(root, "repository");
  const scratch = path.join(root, "scratch");
  const authoredEvalDirectory = path.join(scratch, ".routekit", "evals", "support");
  const authoredRoutingDirectory = path.join(scratch, ".routekit", "routing");
  await Promise.all([
    mkdir(repository),
    mkdir(authoredEvalDirectory, { recursive: true }),
    mkdir(authoredRoutingDirectory, { recursive: true })
  ]);
  await writeValidSuite(authoredEvalDirectory);
  await writeFile(
    path.join(authoredRoutingDirectory, "support.yaml"),
    JSON.stringify({
      version: 1,
      id: "support",
      suite: ".routekit/evals/support/support.eval.ts",
      candidates: ["openai/cheap", "anthropic/strong"],
      judge: "openai/judge",
      eligibility: { minimumPassRate: 0.8 },
      objective: "lowest-cost",
      description: "Customer support policy tasks"
    })
  );
  const promoted = await Effect.runPromise(
    promoteOriAuthoredArtifacts({
      profileId: "support",
      repositoryRoot: repository,
      result: {
        ok: true,
        status: "completed",
        scratchWorkspace: scratch
      }
    })
  );
  const canonicalRepository = await realpath(repository);
  assert.equal(
    promoted.evalPath,
    path.join(canonicalRepository, ".routekit", "evals", "support", "support.eval.ts")
  );
  assert.equal(
    promoted.profilePath,
    path.join(canonicalRepository, ".routekit", "routing", "support.yaml")
  );
  assert.equal(promoted.profile.description, "Customer support policy tasks");
  assert.equal(await exists(path.join(promoted.directory, "data", "cases.json")), true);
});

test("selects the latest successful structured run instead of a newer failed run", async () => {
  const root = await makeRoot("routekit-ori-latest-");
  const scratch = path.join(root, "scratch");
  await mkdir(scratch);
  const suite = await writeValidSuite(scratch);
  const successful = runFor(scratch, suite, {
    finishedAt: "2026-08-16T00:02:00.000Z"
  });
  const failed = runFor(scratch, suite, {
    exitCode: 1,
    finishedAt: "2026-08-16T00:03:00.000Z"
  });

  assert.equal(
    selectLatestSuccessfulOriEvalRun(completedResult(scratch, [successful, failed])).finishedAt,
    "2026-08-16T00:02:00.000Z"
  );
});

test("rejects support traversal and leaves the existing profile untouched", async () => {
  const root = await makeRoot("routekit-ori-traversal-");
  const repository = path.join(root, "repository");
  const scratch = path.join(root, "scratch");
  await Promise.all([mkdir(repository), mkdir(scratch)]);
  const suite = path.join(scratch, "support.eval.ts");
  await writeFile(path.join(root, "outside.json"), "{}\n");
  await writeFile(
    suite,
    'import { readFile } from "node:fs/promises";\nawait readFile(new URL("../outside.json", import.meta.url));\n'
  );
  const existing = path.join(repository, ".routekit", "evals", "support");
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, "keep.txt"), "existing\n");

  await assert.rejects(
    Effect.runPromise(
      promoteOriEvalArtifacts({
        profileId: "support",
        repositoryRoot: repository,
        result: completedResult(scratch, [runFor(scratch, suite)])
      })
    ),
    /escapes the scratch workspace/u
  );
  assert.equal(await readFile(path.join(existing, "keep.txt"), "utf8"), "existing\n");
});

test("rejects ambiguous judge IDs and candidate/test evidence mismatches", async () => {
  const root = await makeRoot("routekit-ori-model-evidence-");
  const repository = path.join(root, "repository");
  const scratch = path.join(root, "scratch");
  await Promise.all([mkdir(repository), mkdir(scratch)]);
  const suite = await writeValidSuite(scratch);
  const baseRun = runFor(scratch, suite);
  const ambiguousJudge: OriStructuredEvalRun = {
    ...baseRun,
    results: [
      ...baseRun.results,
      {
        model: "anthropic/judge",
        role: "judge",
        runKey: "judge-2",
        cutOff: false,
        outcome: "passed"
      }
    ]
  };
  const snapshotRoot = path.join(repository, ".routekit", "published");

  await assert.rejects(
    Effect.runPromise(
      publishOriEvalPolicyHandoff({
        profile: profile(),
        repositoryRoot: repository,
        result: completedResult(scratch, [ambiguousJudge]),
        snapshotRoot
      })
    ),
    /exactly one judge model/u
  );

  await assert.rejects(
    Effect.runPromise(
      publishOriEvalPolicyHandoff({
        profile: profile(),
        repositoryRoot: repository,
        result: completedResult(scratch, [{ ...baseRun, tests: [] }]),
        snapshotRoot
      })
    ),
    /test evidence does not match candidate rows/u
  );
  assert.equal(await exists(path.join(snapshotRoot, "published-routing.v1.json")), false);
});

test("fails closed before publication for cutoff and ineligible evidence", async () => {
  const root = await makeRoot("routekit-ori-fail-closed-");
  const repository = path.join(root, "repository");
  const scratch = path.join(root, "scratch");
  await Promise.all([mkdir(repository), mkdir(scratch)]);
  const suite = await writeValidSuite(scratch);
  const snapshotRoot = path.join(repository, ".routekit", "published");

  await assert.rejects(
    Effect.runPromise(
      publishOriEvalPolicyHandoff({
        profile: profile(),
        repositoryRoot: repository,
        result: completedResult(scratch, [runFor(scratch, suite, { cutOff: true })]),
        snapshotRoot
      })
    ),
    /cutoff or unknown/u
  );
  assert.equal(await exists(path.join(snapshotRoot, "published-routing.v1.json")), false);

  await assert.rejects(
    Effect.runPromise(
      publishOriEvalPolicyHandoff({
        profile: profile({ minimumJudgeScore: 1 }),
        repositoryRoot: repository,
        result: completedResult(scratch, [runFor(scratch, suite)]),
        snapshotRoot
      })
    ),
    /no eligible models/u
  );
  assert.equal(await exists(path.join(snapshotRoot, "published-routing.v1.json")), false);
});
