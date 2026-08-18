import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  bindDimensionComparisonDigests,
  type PendingTestdriveDimensionReport
} from "../eval-routing-testdrive/dimension-matrix-workflow.js";
import { validateDimensionLivePlan } from "../eval-routing-compositional/dimension-live-plan.js";
import {
  type RoutingBasisFixture,
  routingBasisFromFixture
} from "../eval-routing-compositional/qualification.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const fixtureRoot = join(
  repositoryRoot,
  "packages",
  "testkit",
  "src",
  "eval-routing-compositional",
  "fixtures"
);

async function fixtures() {
  const catalogFixture = JSON.parse(
    await readFile(join(fixtureRoot, "routing-basis.json"), "utf8")
  ) as RoutingBasisFixture;
  const plan = JSON.parse(
    await readFile(join(fixtureRoot, "dimension-live-plan.json"), "utf8")
  ) as {
    dimensions: Array<{ dimensionId: string; sourceFiles: string[] }>;
  };
  const inventory = [...new Set(plan.dimensions.flatMap((dimension) => dimension.sourceFiles))];
  return {
    basis: routingBasisFromFixture(catalogFixture),
    plan,
    inventory
  };
}

test("dimension live plan covers all eight basis dimensions in stable order", async () => {
  const input = await fixtures();
  const plan = validateDimensionLivePlan(input.plan, input.basis, input.inventory);

  assert.equal(plan.dimensions.length, 8);
  assert.equal(plan.casesPerDimension, 5);
  assert.deepEqual(
    plan.dimensions.map((dimension) => dimension.dimensionId),
    input.basis.dimensions.map((dimension) => dimension.id)
  );
  for (const source of input.inventory) {
    assert.equal((await readFile(join(repositoryRoot, source))).byteLength > 0, true);
  }
});

test("dimension live plan rejects missing dimensions and sources outside the inventory", async () => {
  const input = await fixtures();
  assert.throws(
    () =>
      validateDimensionLivePlan(
        { ...input.plan, dimensions: input.plan.dimensions.slice(0, -1) },
        input.basis,
        input.inventory
      ),
    /cover the basis exactly/u
  );
  const first = input.plan.dimensions[0]!;
  assert.throws(
    () =>
      validateDimensionLivePlan(
        {
          ...input.plan,
          dimensions: [
            { ...first, sourceFiles: ["outside/inventory.md"] },
            ...input.plan.dimensions.slice(1)
          ]
        },
        input.basis,
        input.inventory
      ),
    /invalid source/u
  );
});

test("dimension reports use authoritative execution digests", () => {
  const pending: PendingTestdriveDimensionReport[] = [
    {
      dimensionId: "gateway-protocols",
      description: "Gateway behavior",
      artifacts: {
        evalDirectory: "dimensions/gateway-protocols/eval",
        manifestPath: "dimensions/gateway-protocols/eval/routekit.eval-manifest.json",
        comparisonPath: "dimensions/gateway-protocols/comparison.json"
      }
    },
    {
      dimensionId: "client-tool-integration",
      description: "Client behavior",
      artifacts: {
        evalDirectory: "dimensions/client-tool-integration/eval",
        manifestPath: "dimensions/client-tool-integration/eval/routekit.eval-manifest.json",
        comparisonPath: "dimensions/client-tool-integration/comparison.json"
      }
    }
  ];
  const reports = bindDimensionComparisonDigests(pending, [
    { profileId: "client-tool-integration", suiteDigest: "execution-client" },
    { profileId: "gateway-protocols", suiteDigest: "execution-gateway" }
  ]);
  assert.deepEqual(
    reports.map((entry) => [entry.dimensionId, entry.suiteDigest]),
    [
      ["gateway-protocols", "execution-gateway"],
      ["client-tool-integration", "execution-client"]
    ]
  );
  assert.throws(
    () =>
      bindDimensionComparisonDigests(pending, [
        { profileId: "gateway-protocols", suiteDigest: "one" },
        { profileId: "gateway-protocols", suiteDigest: "two" }
      ]),
    /exactly once/u
  );
});
