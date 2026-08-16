import { parseRouterConfig } from "@velum-labs/routekit-config";
import { makeRoutingSnapshotStore } from "@velum-labs/routekit-eval-store/effect";
import type {
  ModelCallRecord,
  ProvenanceSink,
  RoutingPolicyReader
} from "@velum-labs/routekit-gateway";
import { RoutingPolicyReadError } from "@velum-labs/routekit-gateway";
import type { RunningRouter } from "@velum-labs/routekit-router";
import { startRouterEffect } from "@velum-labs/routekit-router/effect";
import type { RouteKitPlatform } from "@velum-labs/routekit-runtime/effect";
import { Context, Crypto, Effect, Layer, Ref } from "effect";

import { TestdriveWorkflowError } from "./contracts.js";
import { TestdriveEvidence } from "./evidence.js";

export interface TestdriveEmbeddedRouterService {
  readonly url: string;
  readonly bearerCredential: string;
  readonly recordsSince: (offset: number) => readonly ModelCallRecord[];
  readonly recordCount: () => number;
  readonly close: Effect.Effect<void>;
}

export class TestdriveEmbeddedRouter extends Context.Service<
  TestdriveEmbeddedRouter,
  TestdriveEmbeddedRouterService
>()("@velum-labs/routekit-testkit/TestdriveEmbeddedRouter") {}

export const makeTestdriveEmbeddedRouterLayer = (options: {
  stateHome: string;
  guardOrigin: string;
  guardBearerCredential: string;
  defaultModel: string;
  classifierModel: string;
}): Layer.Layer<
  TestdriveEmbeddedRouter,
  TestdriveWorkflowError,
  RouteKitPlatform | TestdriveEvidence
> =>
  Layer.effect(
    TestdriveEmbeddedRouter,
    Effect.gen(function* () {
      const evidence = yield* TestdriveEvidence;
      const platform = yield* Effect.context<RouteKitPlatform>();
      const crypto = yield* Crypto.Crypto;
      const tokenPart1 = yield* crypto.randomUUIDv4;
      const tokenPart2 = yield* crypto.randomUUIDv4;
      const bearerCredential = `${tokenPart1}${tokenPart2}`;
      const records: ModelCallRecord[] = [];
      const provenance: ProvenanceSink = {
        onModelCall: (record) => {
          records.push(record);
          if (records.length > 1_024) records.shift();
        }
      };
      const snapshots = makeRoutingSnapshotStore(`${options.stateHome}/eval`);
      const listProfiles: RoutingPolicyReader["listProfiles"] = () =>
        snapshots.read().pipe(
          Effect.provide(platform),
          Effect.map((snapshot) => snapshot?.profiles ?? {}),
          Effect.mapError(
            (cause) =>
              new RoutingPolicyReadError({
                profileId: "*",
                message: "failed to read isolated testdrive routing profiles",
                cause
              })
          )
        );
      const policyReader: RoutingPolicyReader = {
        listProfiles,
        getProfile: (profileId) =>
          listProfiles().pipe(Effect.map((profiles) => profiles[profileId]))
      };
      const running: RunningRouter = yield* startRouterEffect({
        config: parseRouterConfig({
          providers: { openai: {} },
          defaultModel: options.defaultModel,
          classifierModel: options.classifierModel
        }),
        host: "127.0.0.1",
        port: 0,
        authToken: bearerCredential,
        env: {
          OPENAI_API_KEY: options.guardBearerCredential,
          OPENAI_BASE_URL: `${options.guardOrigin}/v1`
        },
        policyReader,
        provenance
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TestdriveWorkflowError({
              phase: "router-start",
              detail: "failed to start embedded RouteKit router",
              cause
            })
        )
      );
      const closed = yield* Ref.make(false);
      const close = Ref.modify(closed, (value) => [!value, true] as const).pipe(
        Effect.flatMap((shouldClose) =>
          shouldClose
            ? Effect.exit(running.close.pipe(Effect.provide(platform))).pipe(
                Effect.flatMap((exit) =>
                  evidence.emit({
                    type: "cleanup-finished",
                    phase: "embedded-router",
                    status: exit._tag === "Success" ? "passed" : "failed"
                  })
                ),
                Effect.ignore
              )
            : Effect.void
        )
      );
      yield* Effect.addFinalizer(() => close);
      return TestdriveEmbeddedRouter.of({
        url: running.url,
        bearerCredential,
        recordsSince: (offset) => records.slice(offset),
        recordCount: () => records.length,
        close
      });
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof TestdriveWorkflowError
          ? cause
          : new TestdriveWorkflowError({
              phase: "router-start",
              detail: "embedded RouteKit router setup failed",
              cause
            })
      )
    )
  );
