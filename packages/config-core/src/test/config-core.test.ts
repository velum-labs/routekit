import assert from "node:assert/strict";
import test from "node:test";

import { resolveLayer } from "../index.js";

test("resolves explicit config before defaults", () => {
  assert.deepEqual(resolveLayer(undefined, "file", "default"), {
    value: "file",
    source: "config"
  });
});
