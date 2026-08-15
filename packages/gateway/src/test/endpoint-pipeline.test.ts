import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";

import { runEndpointPipeline } from "../endpoint-pipeline.js";

test("endpoint pipeline executes authenticate, decode, resolve, execute, observe, encode", async () => {
  const stages: string[] = [];
  await Effect.runPromise(
    runEndpointPipeline("request", {
      authenticate: () => Effect.sync(() => stages.push("authenticate")),
      decode: (input) =>
        Effect.sync(() => {
          stages.push("decode");
          return input.length;
        }),
      resolve: (decoded) =>
        Effect.sync(() => {
          stages.push("resolve");
          return decoded * 2;
        }),
      execute: (route) =>
        Effect.sync(() => {
          stages.push("execute");
          return route + 1;
        }),
      observe: (result) =>
        Effect.sync(() => {
          stages.push("observe");
          return String(result);
        }),
      encode: (observed) => Effect.sync(() => stages.push(`encode:${observed}`))
    })
  );
  assert.deepEqual(stages, [
    "authenticate",
    "decode",
    "resolve",
    "execute",
    "observe",
    "encode:15"
  ]);
});
