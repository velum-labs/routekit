import assert from "node:assert/strict";
import { test } from "node:test";

import { runEndpointPipeline } from "../endpoint-pipeline.js";

test("endpoint pipeline executes authenticate, decode, resolve, execute, observe, encode", async () => {
  const stages: string[] = [];
  await runEndpointPipeline("request", {
    authenticate: () => {
      stages.push("authenticate");
    },
    decode: (input) => {
      stages.push("decode");
      return input.length;
    },
    resolve: (decoded) => {
      stages.push("resolve");
      return decoded * 2;
    },
    execute: (route) => {
      stages.push("execute");
      return route + 1;
    },
    observe: (result) => {
      stages.push("observe");
      return String(result);
    },
    encode: (observed) => {
      stages.push(`encode:${observed}`);
    }
  });
  assert.deepEqual(stages, [
    "authenticate",
    "decode",
    "resolve",
    "execute",
    "observe",
    "encode:15"
  ]);
});
