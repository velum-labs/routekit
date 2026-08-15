import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect } from "effect";

import { inspectRepository } from "../inspection.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test("repository inspection finds model surfaces and useful material without build trees", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "routekit-eval-setup-inspect-"));
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "test", "fixtures"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
  await writeFile(
    path.join(root, "src", "support.ts"),
    'client.responses.create({ model: "openai/gpt-test" });\n'
  );
  await writeFile(path.join(root, "src", "system-prompt.md"), "Be accurate.\n");
  await writeFile(path.join(root, "test", "fixtures", "cases.json"), "[]\n");
  await writeFile(path.join(root, "node_modules", "ignored", "model.ts"), "model = 'bad/id'\n");

  const inspection = await Effect.runPromise(
    inspectRepository(root).pipe(Effect.provide(NodeServicesLayer))
  );
  assert.equal(inspection.surfaces.length, 1);
  assert.equal(inspection.surfaces[0]?.path, "src/support.ts");
  assert.equal(inspection.surfaces[0]?.model, "openai/gpt-test");
  assert.equal(inspection.materials.some((item) => item.path === "src/system-prompt.md"), true);
  assert.equal(inspection.materials.some((item) => item.path.includes("node_modules")), false);
});
