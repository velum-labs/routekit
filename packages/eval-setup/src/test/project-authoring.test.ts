import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

import { EvalProjectAuthoringError } from "../errors.js";
import {
  type EvalAuthoringCompletion,
  EvalAuthoringTransport,
  EvalProjectAuthor,
  EvalProjectAuthorLive,
  readProjectAuthoringSources
} from "../project-authoring.js";
import type { EvalProjectConfiguration } from "../project-contracts.js";

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
    excludes: ["Requests that exercise a different dimension"]
  }));

const proposeDimensions = (
  root: string,
  output: unknown,
  requests: EvalAuthoringCompletion[] = []
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const author = yield* EvalProjectAuthor;
      return yield* author.proposeDimensions({
        operationId: "eng-830",
        repositoryRoot: root,
        sourceInventory: ["source.md"],
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

const collectMinimumItems = (value: unknown): number[] => {
  if (typeof value !== "object" || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(collectMinimumItems);
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.minItems === "number" ? [record.minItems] : []),
    ...Object.values(record).flatMap(collectMinimumItems)
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
    assert.deepEqual(collectMinimumItems(schema), [1, 1, 1]);
    const dimensionsSchema = (
      schema.properties as { dimensions?: Record<string, unknown> } | undefined
    )?.dimensions;
    assert.equal(dimensionsSchema?.type, "array");
    assert.equal(dimensionsSchema.minItems, 1);
    assert.equal(dimensionsSchema.maxItems, 10);
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
