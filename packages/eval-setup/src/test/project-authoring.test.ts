import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

import { EvalProjectAuthoringError } from "../errors.js";
import {
  EVAL_AUTHORING_CASES_PER_DIMENSION,
  EVAL_AUTHORING_EVALUATION_OUTPUT_TOKENS,
  type EvalAuthoringCompletion,
  EvalAuthoringTransport,
  EvalProjectAuthor,
  EvalProjectAuthorLive,
  readProjectAuthoringSources
} from "../project-authoring.js";
import {
  EVAL_PROJECT_VERSION,
  type EvalCompositionSuite,
  type EvalDecompositionBenchmark,
  type EvalDimensionSuite,
  type EvalProjectConfiguration
} from "../project-contracts.js";

const withRepository = async (
  use: (input: { readonly root: string; readonly outside: string }) => Promise<void>
) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-author-sources-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "routekit-author-outside-"));
  try {
    await writeFile(path.join(root, "source.md"), "bounded repository source\n");
    await writeFile(path.join(outside, "secret.md"), "outside\n");
    await use({ root, outside });
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true })
    ]);
  }
};

const read = (input: {
  readonly repositoryRoot: string;
  readonly selectedFiles: readonly string[];
  readonly sourceInventory: readonly string[];
}) => Effect.runPromise(readProjectAuthoringSources(input).pipe(Effect.provide(NodeServicesLayer)));

const configuration: EvalProjectConfiguration = {
  workloadDescription: "Route production requests across separable workload dimensions.",
  candidateModels: ["openai/candidate-a", "openai/candidate-b"],
  classifierModel: "openai/classifier",
  authorModel: "claude-code/claude-opus-5",
  judgeModel: "openai/judge",
  objective: { kind: "highest-quality" },
  maximumUnknownWeight: 0.2
};

const dimensions = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `dimension-${String(index + 1)}`,
    description: `Production workload dimension ${String(index + 1)}`,
    includes: [`Requests that exercise dimension ${String(index + 1)}`],
    excludes: ["Requests that exercise a different dimension"],
    inScopeRequest: `Handle a request for dimension ${String(index + 1)}.`,
    nearMissRequest: `Handle a neighboring request outside dimension ${String(index + 1)}.`
  }));

const proposeDimensions = (
  root: string,
  output: unknown,
  requests: EvalAuthoringCompletion[] = [],
  sourceInventory: readonly string[] = ["source.md"]
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const author = yield* EvalProjectAuthor;
      return yield* author.proposeDimensions({
        operationId: "eng-831",
        repositoryRoot: root,
        sourceInventory,
        configuration
      });
    }).pipe(
      Effect.provide(
        EvalProjectAuthorLive.pipe(
          Layer.provide(
            Layer.succeed(
              EvalAuthoringTransport,
              EvalAuthoringTransport.of({
                complete: (input) =>
                  Effect.sync(() => {
                    requests.push(input);
                    return JSON.stringify(output);
                  })
              })
            )
          ),
          Layer.provide(NodeServicesLayer)
        )
      )
    )
  );

const basis = {
  version: 2 as const,
  basisDigest: "basis-digest",
  dimensions: dimensions(5)
};

const dimensionCases = () =>
  Array.from({ length: EVAL_AUTHORING_CASES_PER_DIMENSION }, (_, index) => ({
    id: `dimension-case-${String(index + 1)}`,
    prompt: `Answer production request ${String(index + 1)}.`,
    context: "Reference context.",
    rubric: "State the expected production behavior."
  }));

const dimensionSuite = (dimensionId = basis.dimensions[0]!.id): EvalDimensionSuite => ({
  version: EVAL_PROJECT_VERSION,
  dimensionId,
  maximumOutputTokens: 256,
  cases: dimensionCases()
});

const decompositionWeights = () =>
  basis.dimensions.map((dimension) => ({
    dimensionId: dimension.id,
    weight: 1 / basis.dimensions.length
  }));

const decompositionBenchmark = (): EvalDecompositionBenchmark => ({
  maximumVectorL1Error: 0.25,
  cases: Array.from({ length: EVAL_AUTHORING_CASES_PER_DIMENSION }, (_, index) => ({
    id: `decomposition-case-${String(index + 1)}`,
    request: `Classify production request ${String(index + 1)}.`,
    expected: {
      weights: decompositionWeights(),
      unknownWeight: 0
    }
  }))
});

const compositionSuite = (): EvalCompositionSuite => ({
  maximumOutputTokens: 256,
  minimumWinnerScoreGap: 0.05,
  minimumWinnerAgreement: 0.8,
  cases: Array.from({ length: EVAL_AUTHORING_CASES_PER_DIMENSION }, (_, index) => ({
    id: `composition-case-${String(index + 1)}`,
    prompt: `Compose production response ${String(index + 1)}.`,
    context: "Reference context.",
    rubric: "State the expected composed production behavior.",
    decomposition: {
      weights: decompositionWeights(),
      unknownWeight: 0
    },
    requirements: {
      endpoint: "chat" as const,
      requiresTools: false,
      requiresVision: false,
      inputTokens: 128,
      maxOutputTokens: 256
    }
  }))
});

const proposeEvaluations = (
  root: string,
  outputs: {
    readonly suite?: EvalDimensionSuite;
    readonly decomposition?: EvalDecompositionBenchmark;
    readonly composition?: EvalCompositionSuite;
  },
  requests: EvalAuthoringCompletion[] = []
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const author = yield* EvalProjectAuthor;
      return yield* author.proposeEvaluations({
        operationId: "eng-833",
        repositoryRoot: root,
        sourceInventory: ["source.md"],
        configuration,
        basis
      });
    }).pipe(
      Effect.provide(
        EvalProjectAuthorLive.pipe(
          Layer.provide(
            Layer.succeed(
              EvalAuthoringTransport,
              EvalAuthoringTransport.of({
                complete: (input) =>
                  Effect.sync(() => {
                    requests.push(input);
                    if (input.schemaName === "routekit_dimension_suite") {
                      const dimension = basis.dimensions.find((candidate) =>
                        input.operationId.endsWith(`:${candidate.id}`)
                      );
                      return JSON.stringify(
                        outputs.suite ?? dimensionSuite(dimension?.id ?? basis.dimensions[0]!.id)
                      );
                    }
                    if (input.schemaName === "routekit_decomposition_benchmark") {
                      return JSON.stringify(outputs.decomposition ?? decompositionBenchmark());
                    }
                    return JSON.stringify(outputs.composition ?? compositionSuite());
                  })
              })
            )
          ),
          Layer.provide(NodeServicesLayer)
        )
      )
    )
  );

const collectSchemaNumberKeyword = (value: unknown, keyword: "minItems" | "maxItems"): number[] => {
  if (typeof value !== "object" || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectSchemaNumberKeyword(item, keyword));
  }
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record[keyword] === "number" ? [record[keyword]] : []),
    ...Object.values(record).flatMap((item) => collectSchemaNumberKeyword(item, keyword))
  ];
};

test("authoring reads an exact discovered regular source", async () => {
  await withRepository(async ({ root }) => {
    assert.deepEqual(
      await read({
        repositoryRoot: root,
        selectedFiles: ["source.md"],
        sourceInventory: ["source.md"]
      }),
      [{ path: "source.md", content: "bounded repository source\n" }]
    );
  });
});

test("authoring rejects traversal and absolute selected paths", async () => {
  await withRepository(async ({ root, outside }) => {
    await assert.rejects(
      read({
        repositoryRoot: root,
        selectedFiles: ["../escape.md"],
        sourceInventory: ["../escape.md"]
      }),
      /canonical relative path/u
    );
    const absolute = path.join(outside, "secret.md");
    await assert.rejects(
      read({
        repositoryRoot: root,
        selectedFiles: [absolute],
        sourceInventory: [absolute]
      }),
      /canonical relative path/u
    );
  });
});

test("authoring rejects a discovered path replaced by an external symlink", async () => {
  await withRepository(async ({ root, outside }) => {
    await symlink(path.join(outside, "secret.md"), path.join(root, "external.md"));
    await assert.rejects(
      read({
        repositoryRoot: root,
        selectedFiles: ["external.md"],
        sourceInventory: ["external.md"]
      }),
      /regular non-symlink file/u
    );
  });
});

test("authoring rejects a selected file absent from discovery inventory", async () => {
  await withRepository(async ({ root }) => {
    await assert.rejects(
      read({
        repositoryRoot: root,
        selectedFiles: ["source.md"],
        sourceInventory: []
      }),
      /not in the bounded discovery inventory/u
    );
  });
});

test("dimension authoring sends an Anthropic-compatible structured output schema", async () => {
  await withRepository(async ({ root }) => {
    const requests: EvalAuthoringCompletion[] = [];
    assert.equal(
      (await proposeDimensions(root, { dimensions: dimensions(5) }, requests)).length,
      5
    );
    assert.equal(requests.length, 1);

    const schema = requests[0]?.jsonSchema;
    assert.ok(schema !== undefined);
    assert.deepEqual(collectSchemaNumberKeyword(schema, "minItems"), [1, 1, 1]);
    assert.deepEqual(collectSchemaNumberKeyword(schema, "maxItems"), []);
    const dimensionsSchema = (
      schema.properties as { dimensions?: Record<string, unknown> } | undefined
    )?.dimensions;
    assert.equal(dimensionsSchema?.type, "array");
    assert.equal(dimensionsSchema.minItems, 1);
    assert.equal(dimensionsSchema.maxItems, undefined);
    const dimensionItems = dimensionsSchema.items as Record<string, unknown>;
    assert.deepEqual(dimensionItems.required, [
      "id",
      "description",
      "includes",
      "excludes",
      "inScopeRequest",
      "nearMissRequest"
    ]);
    assert.match(requests[0]!.instructions, /Do not use layer-cake, overlapping, or correlated axes/u);
    assert.match(requests[0]!.instructions, /independent routing axis/u);
    assert.match(requests[0]!.instructions, /without needing another dimension/u);
    assert.match(requests[0]!.instructions, /product behavior XOR how the repository is changed/u);
    assert.match(requests[0]!.instructions, /implementation stacks/u);
    assert.match(requests[0]!.instructions, /tests, documentation, CI, releases/u);
    assert.match(requests[0]!.instructions, /eval\/classifier itself/u);
    assert.match(requests[0]!.instructions, /tools, vision, context length/u);
    assert.match(requests[0]!.instructions, /unknown weight absorb/u);
    assert.match(requests[0]!.instructions, /sibling dimension or unknown, not paraphrase/u);
  });
});

test("dimension authoring requires distinct non-empty contrast pairs", async () => {
  await withRepository(async ({ root }) => {
    const missingContrast = dimensions(5).map(({ nearMissRequest: _, ...dimension }) => dimension);
    await assert.rejects(
      proposeDimensions(root, { dimensions: missingContrast }),
      (error: unknown) => {
        assert.ok(error instanceof EvalProjectAuthoringError);
        assert.equal(error.detail, "dimension proposal failed validation");
        return true;
      }
    );

    for (const [inScopeRequest, nearMissRequest] of [
      ["", "A neighboring request."],
      ["   ", "A neighboring request."],
      ["The same request.", " the same request. "]
    ] as const) {
      const invalid = dimensions(5);
      invalid[0] = { ...invalid[0]!, inScopeRequest, nearMissRequest };
      await assert.rejects(
        proposeDimensions(root, { dimensions: invalid }),
        (error: unknown) => {
          assert.ok(error instanceof EvalProjectAuthoringError);
          assert.equal(error.detail, "dimension proposal failed validation");
          assert.match(String(error.cause), /contrast|inScopeRequest|nearMissRequest/u);
          return true;
        }
      );
    }
  });
});

test("dimension authoring rejects repeated exclusive requests and mixed repository layers", async () => {
  await withRepository(async ({ root }) => {
    const repeatedExclusiveRequest = dimensions(5);
    repeatedExclusiveRequest[1] = {
      ...repeatedExclusiveRequest[1]!,
      inScopeRequest: ` ${repeatedExclusiveRequest[0]!.inScopeRequest.toUpperCase()} `
    };
    await assert.rejects(
      proposeDimensions(root, { dimensions: repeatedExclusiveRequest }),
      (error: unknown) => {
        assert.ok(error instanceof EvalProjectAuthoringError);
        assert.match(String(error.cause), /in-scope requests must be pairwise distinct/u);
        return true;
      }
    );

    const mixedProductAndProcess = dimensions(5);
    mixedProductAndProcess[4] = {
      ...mixedProductAndProcess[4]!,
      id: "tests-and-release",
      description: "Repository tests, CI, and release operations",
      includes: ["Changes to tests, documentation, CI, and releases"]
    };
    await assert.rejects(
      proposeDimensions(root, { dimensions: mixedProductAndProcess }),
      (error: unknown) => {
        assert.ok(error instanceof EvalProjectAuthoringError);
        assert.match(
          String(error.cause),
          /forbidden implementation, repository-layer, or eval axis/u
        );
        return true;
      }
    );
  });
});

test("dimension authoring rejects an axis that includes almost every inventory file", async () => {
  await withRepository(async ({ root }) => {
    const sourceInventory = ["source.md", "alpha.ts", "beta.ts", "gamma.ts", "delta.ts"];
    await Promise.all(
      sourceInventory
        .filter((sourcePath) => sourcePath !== "source.md")
        .map((sourcePath) => writeFile(path.join(root, sourcePath), `${sourcePath}\n`))
    );
    const broadAxis = dimensions(5);
    broadAxis[0] = {
      ...broadAxis[0]!,
      includes: [`Changes across ${sourceInventory.join(", ")}`]
    };
    await assert.rejects(
      proposeDimensions(root, { dimensions: broadAxis }, [], sourceInventory),
      (error: unknown) => {
        assert.ok(error instanceof EvalProjectAuthoringError);
        assert.match(String(error.cause), /includes almost every inventory file/u);
        return true;
      }
    );
  });
});

test("dimension authoring enforces routing basis counts after structured output parsing", async () => {
  await withRepository(async ({ root }) => {
    for (const count of [4, 11]) {
      await assert.rejects(
        proposeDimensions(root, { dimensions: dimensions(count) }),
        (error: unknown) => {
          assert.ok(error instanceof EvalProjectAuthoringError);
          assert.equal(error.detail, "dimension proposal failed validation");
          assert.match(String(error.cause), /between 5 and 10 dimensions/u);
          return true;
        }
      );
    }

    const missingBoundary = dimensions(5);
    missingBoundary[0] = { ...missingBoundary[0]!, includes: [] };
    await assert.rejects(
      proposeDimensions(root, { dimensions: missingBoundary }),
      (error: unknown) => {
        assert.ok(error instanceof EvalProjectAuthoringError);
        assert.equal(error.detail, "dimension proposal failed validation");
        assert.match(String(error.cause), /inclusion and exclusion boundaries/u);
        return true;
      }
    );
  });
});

test("evaluation authoring enforces Anthropic-deferred bounds after parsing", async () => {
  await withRepository(async ({ root }) => {
    for (const maximumOutputTokens of [0, 16_385]) {
      await assert.rejects(
        proposeEvaluations(root, {
          suite: { ...dimensionSuite(), maximumOutputTokens }
        }),
        (error: unknown) => {
          assert.ok(error instanceof EvalProjectAuthoringError);
          assert.match(error.detail, /suite .* failed validation/u);
          assert.match(String(error.cause), /maximumOutputTokens/u);
          return true;
        }
      );
    }

    await assert.rejects(
      proposeEvaluations(root, {
        suite: {
          ...dimensionSuite(),
          cases: dimensionCases().slice(0, EVAL_AUTHORING_CASES_PER_DIMENSION - 1)
        }
      }),
      (error: unknown) => {
        assert.ok(error instanceof EvalProjectAuthoringError);
        assert.match(String(error.cause), /cases must contain at least 20 items/u);
        return true;
      }
    );

    await assert.rejects(
      proposeEvaluations(root, {
        decomposition: { ...decompositionBenchmark(), maximumVectorL1Error: 3 }
      }),
      (error: unknown) => {
        assert.ok(error instanceof EvalProjectAuthoringError);
        assert.equal(error.detail, "decomposition benchmark failed validation");
        assert.match(String(error.cause), /maximumVectorL1Error/u);
        return true;
      }
    );

    await assert.rejects(
      proposeEvaluations(root, {
        composition: { ...compositionSuite(), minimumWinnerAgreement: 2 }
      }),
      (error: unknown) => {
        assert.ok(error instanceof EvalProjectAuthoringError);
        assert.equal(error.detail, "composition benchmark failed validation");
        assert.match(String(error.cause), /minimumWinnerAgreement/u);
        return true;
      }
    );
  });
});

test("evaluation authoring budgets enough output for all twenty requested cases", async () => {
  await withRepository(async ({ root }) => {
    const requests: EvalAuthoringCompletion[] = [];
    const proposal = await proposeEvaluations(root, {}, requests);

    assert.equal(proposal.suites.length, basis.dimensions.length);
    assert.equal(requests.length, basis.dimensions.length + 2);
    assert.ok(
      requests.every(
        (request) => request.maximumOutputTokens === EVAL_AUTHORING_EVALUATION_OUTPUT_TOKENS
      )
    );
    assert.ok(
      requests.every(
        (request) =>
          request.instructions.includes("exactly 20") &&
          request.instructions.includes("Keep each case concise")
      )
    );
  });
});
