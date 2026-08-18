import assert from "node:assert/strict";
import { test } from "node:test";

// Each import is intentionally separate: restoring any retired name makes its
// expected-error directive unused and fails the package build.
// @ts-expect-error RoutingProfile is deleted.
import type { RoutingProfile } from "@velum-labs/routekit-eval-contracts";
// @ts-expect-error CompiledRoutingPolicy is deleted.
import type { CompiledRoutingPolicy } from "@velum-labs/routekit-eval-contracts";
// @ts-expect-error PublishedRoutingSnapshot is deleted.
import type { PublishedRoutingSnapshot } from "@velum-labs/routekit-eval-contracts";
// @ts-expect-error ROUTING_SNAPSHOT_VERSION is deleted.
import type { ROUTING_SNAPSHOT_VERSION } from "@velum-labs/routekit-eval-contracts";
// @ts-expect-error EvalWorkerRequest and its token field are deleted.
import type { EvalWorkerRequest } from "@velum-labs/routekit-eval-contracts";
// @ts-expect-error The direct toy runner module is deleted.
import type { runEvalSuite as directRunEvalSuite } from "../run.js";
// @ts-expect-error The toy runner is not exported from the package root.
import type { runEvalSuite as rootRunEvalSuite } from "../index.js";

test("retired ENG-814 imports remain compile failures", () => {
  assert.ok(true);
});
