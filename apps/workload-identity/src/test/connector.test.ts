import assert from "node:assert/strict";
import test from "node:test";
import { AWS_ASSERTION_LIFETIME_SECONDS } from "../connector.js";

test("AWS identity assertions stay within the minimum short-lived window", () => {
  assert.equal(AWS_ASSERTION_LIFETIME_SECONDS, 60);
});
