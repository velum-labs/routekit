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
import { RouteKitFailure, type RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { Effect, FileSystem } from "effect";

export type EvalWorkflowCliInput = {
  readonly profileId: string;
  readonly repositoryRoot?: string;
  readonly gatewayUrl?: string;
  readonly token?: string;
  readonly tokenFile?: string;
  readonly authorModel?: string;
  readonly judgeModel?: string;
  readonly description?: string;
  readonly env?: NodeJS.ProcessEnv;
};

function workflowLayer(input: EvalWorkflowCliInput, bearerCredential: string | undefined) {
  return makeRouteKitEvalSetupLayer({
    gatewayUrl: input.gatewayUrl?.trim() || "http://127.0.0.1",
    snapshotRoot: join(routekitHome(input.env), "eval"),
    authorHarness: "pi",
    authorModel: input.authorModel?.trim() || "openai/gpt-5.6-terra",
    judgeModel: input.judgeModel?.trim() || "openai/gpt-5.6-terra",
    ...(bearerCredential === undefined ? {} : { bearerCredential })
  });
}

const bearerCredential = (
  input: EvalWorkflowCliInput
): Effect.Effect<string | undefined, unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const direct = input.token?.trim();
    const tokenFile = input.tokenFile ?? input.env?.ROUTEKIT_EVAL_TOKEN_FILE;
    if (direct !== undefined && direct.length > 0 && tokenFile !== undefined) {
      return yield* new RouteKitFailure({
        message: "provide only one eval token source"
      });
    }
    if (direct !== undefined && direct.length > 0) return direct;
    if (tokenFile !== undefined) {
      const fs = yield* FileSystem.FileSystem;
      const tokenPath = resolve(tokenFile);
      const info = yield* fs.stat(tokenPath);
      if (info.type !== "File" || Number(info.size) > 16_384 || (info.mode & 0o077) !== 0) {
        return yield* new RouteKitFailure({
          message: "eval token file must be a private regular file no larger than 16 KiB"
        });
      }
      const fromFile = (yield* fs.readFileString(tokenPath)).trim();
      return fromFile.length === 0 ? undefined : fromFile;
    }
    const fromEnvironment = input.env?.ROUTEKIT_EVAL_TOKEN?.trim();
    return fromEnvironment === undefined || fromEnvironment.length === 0
      ? undefined
      : fromEnvironment;
  });

function withSetup<A, E>(
  input: EvalWorkflowCliInput,
  use: (setup: EvalSetup["Service"], repositoryRoot: string) => Effect.Effect<A, E>
): Effect.Effect<A, E, RouteKitPlatform> {
  const repositoryRoot = resolve(input.repositoryRoot ?? ".");
  return Effect.gen(function* () {
    const token = yield* bearerCredential(input);
    return yield* Effect.gen(function* () {
      return yield* use(yield* EvalSetup, repositoryRoot);
    }).pipe(Effect.provide(workflowLayer(input, token)));
  }) as Effect.Effect<A, E, RouteKitPlatform>;
}

export function evalPrepareCommand(
  input: EvalWorkflowCliInput
): Effect.Effect<SetupAnswerResult, unknown, RouteKitPlatform> {
  return withSetup(input, (setup, repositoryRoot) =>
    setup.prepare(repositoryRoot, input.profileId, {
      ...(input.description === undefined ? {} : { description: input.description })
    })
  );
}

export function evalStatusCommand(
  input: EvalWorkflowCliInput
): Effect.Effect<SetupStatus | undefined, unknown, RouteKitPlatform> {
  return withSetup(input, (setup, repositoryRoot) => setup.status(repositoryRoot, input.profileId));
}

export function evalAnswerCommand(
  input: EvalWorkflowCliInput & { readonly answer?: string; readonly answerFile?: string }
): Effect.Effect<SetupAnswerResult, unknown, RouteKitPlatform> {
  return Effect.gen(function* () {
    const answer =
      input.answer ??
      (input.answerFile === undefined
        ? undefined
        : yield* (yield* FileSystem.FileSystem).readFileString(resolve(input.answerFile)));
    if (answer === undefined || answer.trim().length === 0) {
      return yield* new RouteKitFailure({
        message: "eval answer requires non-empty answer text"
      });
    }
    return yield* withSetup(input, (setup, repositoryRoot) =>
      setup.answer(repositoryRoot, input.profileId, answer)
    );
  }) as Effect.Effect<SetupAnswerResult, unknown, RouteKitPlatform>;
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
  return withSetup(input, (setup, repositoryRoot) =>
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
