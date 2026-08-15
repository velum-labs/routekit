import { join, resolve } from "node:path";

import { routekitHome } from "@velum-labs/routekit-config";
import { EVAL_POLICY, type EvalPolicy } from "@velum-labs/routekit-eval-contracts";
import { makeRouteKitEvalSetupLayer } from "@velum-labs/routekit-eval-service";
import type {
  SetupAnswerResult,
  SetupEstimate,
  SetupRunResult,
  SetupStatus
} from "@velum-labs/routekit-eval-setup";
import { EvalSetup } from "@velum-labs/routekit-eval-setup";
import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { Effect } from "effect";

export type EvalWorkflowCliInput = {
  readonly profileId: string;
  readonly repositoryRoot?: string;
  readonly gatewayUrl?: string;
  readonly token?: string;
  readonly env?: NodeJS.ProcessEnv;
};

const DEFAULT_PILOT_TIMEOUT_MS = 120_000;
const DEFAULT_FULL_TIMEOUT_MS = 300_000;

function requireGatewayUrl(input: EvalWorkflowCliInput): string {
  const gatewayUrl = input.gatewayUrl?.trim();
  if (gatewayUrl === undefined || gatewayUrl.length === 0) {
    throw new Error("--url is required for paid eval execution");
  }
  return gatewayUrl;
}

function workflowLayer(input: EvalWorkflowCliInput) {
  return makeRouteKitEvalSetupLayer({
    gatewayUrl: input.gatewayUrl?.trim() || "http://127.0.0.1",
    snapshotRoot: join(routekitHome(input.env), "eval"),
    pilot: { timeoutMs: DEFAULT_PILOT_TIMEOUT_MS },
    full: { timeoutMs: DEFAULT_FULL_TIMEOUT_MS },
    ...(input.token === undefined ? {} : { bearerCredential: input.token })
  });
}

function withSetup<A, E>(
  input: EvalWorkflowCliInput,
  use: (setup: EvalSetup["Service"], repositoryRoot: string) => Effect.Effect<A, E>
): Effect.Effect<A, E, RouteKitPlatform> {
  const repositoryRoot = resolve(input.repositoryRoot ?? ".");
  return Effect.gen(function* () {
    return yield* use(yield* EvalSetup, repositoryRoot);
  }).pipe(Effect.provide(workflowLayer(input))) as Effect.Effect<A, E, RouteKitPlatform>;
}

export function evalPrepareCommand(
  input: EvalWorkflowCliInput
): Effect.Effect<SetupAnswerResult, unknown, RouteKitPlatform> {
  return withSetup(input, (setup, repositoryRoot) =>
    setup.prepare(repositoryRoot, input.profileId)
  );
}

export function evalStatusCommand(
  input: EvalWorkflowCliInput
): Effect.Effect<SetupStatus | undefined, unknown, RouteKitPlatform> {
  return withSetup(input, (setup, repositoryRoot) => setup.status(repositoryRoot, input.profileId));
}

export function evalAnswerCommand(
  input: EvalWorkflowCliInput & { readonly answer: string }
): Effect.Effect<SetupAnswerResult, unknown, RouteKitPlatform> {
  return withSetup(input, (setup, repositoryRoot) =>
    setup.answer(repositoryRoot, input.profileId, input.answer)
  );
}

export function evalValidateCommand(
  input: EvalWorkflowCliInput
): Effect.Effect<SetupAnswerResult, unknown, RouteKitPlatform> {
  return withSetup(input, (setup, repositoryRoot) =>
    setup.validate(repositoryRoot, input.profileId)
  );
}

export function evalEstimateCommand(
  input: EvalWorkflowCliInput & { readonly mode: "pilot" | "full" }
): Effect.Effect<SetupEstimate, unknown, RouteKitPlatform> {
  return withSetup(input, (setup, repositoryRoot) =>
    setup.estimate(repositoryRoot, input.profileId, input.mode)
  );
}

export function evalRunCommand(
  input: EvalWorkflowCliInput
): Effect.Effect<SetupRunResult, unknown, RouteKitPlatform> {
  const gatewayUrl = requireGatewayUrl(input);
  return withSetup({ ...input, gatewayUrl }, (setup, repositoryRoot) =>
    setup.runApproved(repositoryRoot, input.profileId)
  );
}

export function evalPublishCommand(
  input: EvalWorkflowCliInput
): Effect.Effect<SetupRunResult, unknown, RouteKitPlatform> {
  return withSetup(input, (setup, repositoryRoot) =>
    setup.publishApproved(repositoryRoot, input.profileId)
  );
}

export const policyShowCommand: Effect.Effect<EvalPolicy> = Effect.succeed(EVAL_POLICY);
