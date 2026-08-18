import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect } from "effect";

import { readProjectAuthoringSources } from "../project-authoring.js";

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
