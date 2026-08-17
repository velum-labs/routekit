import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  type RoutingAreaCatalogFixture,
  routingAreaCatalogFromFixture
} from "../eval-routing-v2/qualification.js";
import { validateAreaLivePlan } from "../eval-routing-v2/area-live-plan.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const fixtureRoot = join(
  repositoryRoot,
  "packages",
  "testkit",
  "src",
  "eval-routing-v2",
  "fixtures"
);

async function fixtures() {
  const catalogFixture = JSON.parse(
    await readFile(join(fixtureRoot, "routekit-area-catalog.v1.json"), "utf8")
  ) as RoutingAreaCatalogFixture;
  const plan = JSON.parse(
    await readFile(join(fixtureRoot, "area-live-plan.v1.json"), "utf8")
  ) as {
    areas: Array<{ areaId: string; sourceFiles: string[] }>;
  };
  const inventory = [...new Set(plan.areas.flatMap((area) => area.sourceFiles))];
  return {
    catalog: routingAreaCatalogFromFixture(catalogFixture),
    plan,
    inventory
  };
}

test("area live plan covers all eight catalog areas in stable order", async () => {
  const input = await fixtures();
  const plan = validateAreaLivePlan(input.plan, input.catalog, input.inventory);

  assert.equal(plan.areas.length, 8);
  assert.equal(plan.casesPerArea, 5);
  assert.deepEqual(
    plan.areas.map((area) => area.areaId),
    input.catalog.areas.map((area) => area.id)
  );
  for (const source of input.inventory) {
    assert.equal((await readFile(join(repositoryRoot, source))).byteLength > 0, true);
  }
});

test("area live plan rejects missing areas and sources outside the inventory", async () => {
  const input = await fixtures();
  assert.throws(
    () =>
      validateAreaLivePlan(
        { ...input.plan, areas: input.plan.areas.slice(0, -1) },
        input.catalog,
        input.inventory
      ),
    /cover the catalog exactly/u
  );
  const first = input.plan.areas[0]!;
  assert.throws(
    () =>
      validateAreaLivePlan(
        {
          ...input.plan,
          areas: [
            { ...first, sourceFiles: ["outside/inventory.md"] },
            ...input.plan.areas.slice(1)
          ]
        },
        input.catalog,
        input.inventory
      ),
    /invalid source/u
  );
});
