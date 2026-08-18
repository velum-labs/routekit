import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

import { NodeRuntime } from "@effect/platform-node";
import { RouteKitLive } from "@velum-labs/routekit-runtime/effect";
import { Config, Console, Effect, Redacted } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  DEFAULT_TESTDRIVE_FAILSAFES,
  TestdriveConfigurationError,
  TestdriveGuardError,
  TestdriveProcessError,
  TestdriveWorkflowError
} from "./contracts.js";
import { runLiveEvalRoutingTestdrive } from "./runner.js";

const positive = (name: string, value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TestdriveConfigurationError({ detail: `${name} must be positive` });
  }
  return value;
};

export const formatEstimatedUsd = (report: {
  readonly estimatedCostUsd: number;
  readonly unpricedCalls: number;
}): string => (report.unpricedCalls > 0 ? "unknown" : report.estimatedCostUsd.toFixed(6));

const loadCredential = (path: string) =>
  Effect.gen(function* () {
    const resolved = resolve(path);
    const info = yield* Effect.tryPromise({
      try: () => lstat(resolved),
      catch: () =>
        new TestdriveConfigurationError({
          detail: "Orbit token file could not be inspected"
        })
    });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 16_384 ||
      (info.mode & 0o777) !== 0o600
    ) {
      return yield* new TestdriveConfigurationError({
        detail: "Orbit token file must be a non-symlink regular file with mode 0600 no larger than 16 KiB"
      });
    }
    const token = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW),
        catch: () =>
          new TestdriveConfigurationError({
            detail: "Orbit token file could not be opened safely"
          })
      }),
      (handle) =>
        Effect.gen(function* () {
          const openedInfo = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: () =>
              new TestdriveConfigurationError({
                detail: "Orbit token file could not be verified after opening"
              })
          });
          if (
            !openedInfo.isFile() ||
            openedInfo.size > 16_384 ||
            (openedInfo.mode & 0o777) !== 0o600 ||
            openedInfo.dev !== info.dev ||
            openedInfo.ino !== info.ino
          ) {
            return yield* new TestdriveConfigurationError({
              detail: "Orbit token file changed or became unsafe while opening"
            });
          }
          return yield* Effect.tryPromise({
            try: () => handle.readFile("utf8"),
            catch: () =>
              new TestdriveConfigurationError({
                detail: "Orbit token file could not be read"
              })
          });
        }),
      (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore)
    );
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      return yield* new TestdriveConfigurationError({ detail: "Orbit token file is empty" });
    }
    return Redacted.make(trimmed);
  });

const live = Flag.boolean("live").pipe(Flag.withDescription("authorize the live billed testdrive"));
const classifierOnly = Flag.boolean("classifier-only").pipe(
  Flag.withDescription("run only the 26-case compositional classifier qualification")
);
const repository = Flag.string("repository").pipe(
  Flag.withDescription("RouteKit repository root"),
  Flag.withDefault(".")
);
const orbitUrl = Flag.string("orbit-url").pipe(
  Flag.withDescription("canonical Orbit gateway URL"),
  Flag.withDefault("https://orbit-gateway.velum.sh")
);
const orbitTokenFile = Flag.string("orbit-token-file").pipe(
  Flag.withDescription("private file containing a dedicated Orbit data token")
);
const maxCalls = Flag.integer("max-calls").pipe(
  Flag.withDefault(DEFAULT_TESTDRIVE_FAILSAFES.maxEgressCalls)
);
const maxInputTokens = Flag.integer("max-input-tokens").pipe(
  Flag.withDefault(DEFAULT_TESTDRIVE_FAILSAFES.maxInputTokens)
);
const maxOutputTokens = Flag.integer("max-output-tokens").pipe(
  Flag.withDefault(DEFAULT_TESTDRIVE_FAILSAFES.maxOutputTokens)
);
const maxEstimatedUsd = Flag.string("max-estimated-usd").pipe(
  Flag.withDefault(String(DEFAULT_TESTDRIVE_FAILSAFES.maxEstimatedCostUsd))
);
const maxWallMs = Flag.integer("max-wall-ms").pipe(
  Flag.withDefault(DEFAULT_TESTDRIVE_FAILSAFES.maxWallTimeMs)
);
const maxOutputTokensPerCall = Flag.integer("max-output-tokens-per-call").pipe(
  Flag.withDefault(DEFAULT_TESTDRIVE_FAILSAFES.maxOutputTokensPerCall)
);

export const evalRoutingTestdriveCommand = Command.make(
  "routekit-eval-routing-testdrive",
  {
    live,
    classifierOnly,
    repository,
    orbitUrl,
    orbitTokenFile,
    maxCalls,
    maxInputTokens,
    maxOutputTokens,
    maxEstimatedUsd,
    maxWallMs,
    maxOutputTokensPerCall
  },
  Effect.fn("EvalRoutingTestdrive.main")(function* (options) {
    if (!options.live) {
      return yield* new TestdriveConfigurationError({
        detail: "pass --live to authorize billed model calls"
      });
    }
    const liveGate = yield* Config.string("ROUTEKIT_LIVE_E2E");
    if (liveGate !== "1") {
      return yield* new TestdriveConfigurationError({
        detail: "set ROUTEKIT_LIVE_E2E=1 to authorize billed model calls"
      });
    }
    const repositoryRoot = resolve(options.repository);
    const credential = yield* loadCredential(options.orbitTokenFile);
    const report = yield* runLiveEvalRoutingTestdrive({
      repositoryRoot,
      upstreamOrigin: options.orbitUrl,
      upstreamBearerCredential: Redacted.value(credential),
      classifierOnly: options.classifierOnly,
      failsafes: {
        maxEgressCalls: positive("max-calls", options.maxCalls),
        maxInputTokens: positive("max-input-tokens", options.maxInputTokens),
        maxOutputTokens: positive("max-output-tokens", options.maxOutputTokens),
        maxEstimatedCostUsd: positive("max-estimated-usd", Number(options.maxEstimatedUsd)),
        maxWallTimeMs: positive("max-wall-ms", options.maxWallMs),
        maxOutputTokensPerCall: positive(
          "max-output-tokens-per-call",
          options.maxOutputTokensPerCall
        )
      }
    }).pipe(Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(credential))));
    yield* Console.log(
      `RESULT status=${report.status} run_id=${report.runId} dimensions=${String(report.dimensionMatrixQualification?.dimensionCount ?? 0)} calls=${String(report.ledger.calls)} input_tokens=${String(report.ledger.inputTokens)} output_tokens=${String(report.ledger.outputTokens)} estimated_usd=${formatEstimatedUsd(report.ledger)} known_priced_subtotal_usd=${report.ledger.estimatedCostUsd.toFixed(6)} unpriced_calls=${String(report.ledger.unpricedCalls)} dollar_failsafe=${report.ledger.dollarFailsafeStatus}`
    );
  })
).pipe(
  Command.withDescription(
    "run the billed eight-dimension compositional routing qualification or only its decomposition benchmark"
  )
);

export const runEvalRoutingTestdriveMain = (): void => {
  evalRoutingTestdriveCommand.pipe(
    Command.run({ version: "1" }),
    Effect.catch((error) => {
      const failure =
        error instanceof TestdriveConfigurationError
          ? { code: "configuration", detail: error.detail }
          : error instanceof TestdriveWorkflowError
            ? { code: error.phase, detail: error.detail }
            : error instanceof TestdriveGuardError
              ? { code: error.code, detail: error.detail }
              : error instanceof TestdriveProcessError
                ? { code: "process", detail: error.detail }
                : {
                    code: "unexpected",
                    detail: "live eval-routing testdrive failed unexpectedly"
                  };
      return Console.error(
        `RESULT status=failed code=${failure.code} message=${failure.detail}`
      ).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1))));
    }),
    Effect.provide(RouteKitLive),
    NodeRuntime.runMain({ disableErrorReporting: true })
  );
};
