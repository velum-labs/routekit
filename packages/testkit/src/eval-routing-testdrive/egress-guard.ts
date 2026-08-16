import { createServer } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { executeWebRequest } from "@velum-labs/routekit-runtime/effect";
import { Context, Effect, Layer, Scope } from "effect";
import { HttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { type TestdriveFailsafes, TestdriveGuardError } from "./contracts.js";
import { TestdriveEvidence } from "./evidence.js";
import { TestdriveLedger } from "./ledger.js";
import {
  estimateTestdriveCostUsd,
  resolveTestdrivePricing,
  unpricedTestdrivePricing
} from "./pricing.js";
import {
  requestWithUsage,
  reservationFromRequest,
  responseWithEstimatedCost,
  usageFromResponseText
} from "./usage.js";

const GENERATION_PATHS = new Set([
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/messages",
  "/v1/responses",
  "/backend-api/codex/responses"
]);

export interface TestdriveEgressGuardService {
  readonly origin: string;
}

export class TestdriveEgressGuard extends Context.Service<
  TestdriveEgressGuard,
  TestdriveEgressGuardService
>()("@velum-labs/routekit-testkit/TestdriveEgressGuard") {}

const normalizedUpstreamUrl = (origin: string, requestUrl: string): string => {
  const upstream = new URL(origin);
  const incoming = new URL(requestUrl, "http://testdrive.invalid");
  const base = upstream.pathname.endsWith("/") ? upstream.pathname.slice(0, -1) : upstream.pathname;
  upstream.pathname =
    base === "/v1" && incoming.pathname.startsWith("/v1/")
      ? `${base}${incoming.pathname.slice("/v1".length)}`
      : `${base}${incoming.pathname}`;
  upstream.search = incoming.search;
  return upstream.toString();
};

const responseBytes = (response: Response) =>
  Effect.promise(() =>
    response.arrayBuffer().then(
      (value) => ({ ok: true as const, value: new Uint8Array(value) }),
      (cause: unknown) => ({ ok: false as const, cause })
    )
  );

const publicGuardFailure = (error: TestdriveGuardError): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    {
      error: {
        type: "routekit_eval_testdrive_failsafe",
        code: error.code,
        message: "live eval-routing testdrive egress was stopped by a failsafe"
      }
    },
    { status: 429 }
  );

export const makeTestdriveEgressGuardLayer = (options: {
  readonly upstreamOrigin: string;
  readonly upstreamBearerCredential: string;
  readonly inboundBearerCredential: string;
  readonly failsafes: TestdriveFailsafes;
}): Layer.Layer<
  TestdriveEgressGuard,
  TestdriveGuardError,
  HttpClient.HttpClient | TestdriveEvidence | TestdriveLedger
> =>
  Layer.effect(
    TestdriveEgressGuard,
    Effect.gen(function* () {
      const origin = yield* Effect.try({
        try: () => new URL(options.upstreamOrigin),
        catch: () =>
          new TestdriveGuardError({
            code: "measurement-missing",
            detail: "Orbit origin must be an absolute HTTP(S) URL"
          })
      });
      if (
        origin.protocol !== "https:" ||
        origin.hostname !== "orbit-gateway.velum.sh" ||
        (origin.port !== "" && origin.port !== "443") ||
        origin.username.length > 0 ||
        origin.password.length > 0 ||
        !["/", "/v1", "/v1/"].includes(origin.pathname) ||
        origin.search.length > 0 ||
        origin.hash.length > 0
      ) {
        return yield* new TestdriveGuardError({
          code: "measurement-missing",
          detail: "Orbit origin must be the canonical HTTPS gateway origin or /v1 base"
        });
      }
      const evidence = yield* TestdriveEvidence;
      const ledger = yield* TestdriveLedger;
      const app = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const pathname = new URL(request.url, "http://testdrive.invalid").pathname;
        const authorized =
          request.headers.authorization === `Bearer ${options.inboundBearerCredential}`;
        if (!authorized) {
          return HttpServerResponse.jsonUnsafe(
            { error: { type: "unauthorized", message: "egress guard authentication required" } },
            { status: 401 }
          );
        }
        const isDiscovery =
          request.method === "GET" &&
          (pathname === "/v1/models" ||
            /^\/v1\/models\/[A-Za-z0-9._:/-]+\/endpoints$/u.test(pathname));
        const isGeneration = request.method === "POST" && GENERATION_PATHS.has(pathname);
        if ((!isDiscovery && !isGeneration) || new URL(request.url, "http://x").search !== "") {
          return HttpServerResponse.jsonUnsafe(
            { error: { type: "not_found", message: "egress guard route not allowed" } },
            { status: 404 }
          );
        }
        const body =
          request.method === "GET" ? new Uint8Array() : new Uint8Array(yield* request.arrayBuffer);
        let reservation:
          | (Awaited<ReturnType<typeof reservationFromRequest>> & {
              id: number;
              estimatedCostUsd: number;
              pricing: NonNullable<ReturnType<typeof resolveTestdrivePricing>>;
            })
          | undefined;
        if (isGeneration) {
          const requested = yield* Effect.try({
            try: () => reservationFromRequest(body, options.failsafes.maxOutputTokensPerCall),
            catch: (cause) =>
              new TestdriveGuardError({
                code: "measurement-missing",
                detail: cause instanceof Error ? cause.message : String(cause)
              })
          });
          const pricing =
            resolveTestdrivePricing(requested.model) ?? unpricedTestdrivePricing(requested.model);
          reservation = yield* ledger.reserve({ ...requested, pricing });
          yield* evidence.emit({
            type: "egress-reserved",
            phase: "egress",
            model: requested.model,
            callId: String(reservation.id),
            inputTokens: requested.inputTokens,
            outputTokens: requested.outputTokens,
            estimatedCostUsd: reservation.estimatedCostUsd
          });
        }
        const contentType = request.headers["content-type"] ?? "application/json";
        const forwardedBody = isGeneration ? requestWithUsage(body) : body;
        const targetUrl = normalizedUpstreamUrl(options.upstreamOrigin, request.url);
        const upstream = yield* executeWebRequest(targetUrl, {
          method: request.method,
          headers: {
            authorization: `Bearer ${options.upstreamBearerCredential}`,
            accept: request.headers.accept ?? "*/*",
            "content-type": contentType,
            ...(request.headers["anthropic-version"] === undefined
              ? {}
              : { "anthropic-version": request.headers["anthropic-version"] })
          },
          ...(forwardedBody.byteLength === 0 ? {} : { body: forwardedBody })
        }).pipe(
          Effect.tapError(() =>
            reservation === undefined
              ? Effect.void
              : ledger.markUnknown(reservation).pipe(Effect.ignore)
          ),
          Effect.mapError(
            () =>
              new TestdriveGuardError({
                code: "measurement-missing",
                detail: "Orbit egress request failed"
              })
          )
        );
        if (upstream.url !== "" && upstream.url !== targetUrl) {
          if (reservation !== undefined) yield* ledger.markUnknown(reservation);
          return yield* new TestdriveGuardError({
            code: "measurement-missing",
            detail: "Orbit egress redirect is not allowed"
          });
        }
        const buffered = yield* responseBytes(upstream);
        if (!buffered.ok) {
          if (reservation !== undefined) yield* ledger.markUnknown(reservation);
          return yield* new TestdriveGuardError({
            code: "measurement-missing",
            detail: "Orbit egress response could not be buffered"
          });
        }
        let outgoing = buffered.value;
        if (reservation !== undefined) {
          const usage = usageFromResponseText(new TextDecoder().decode(buffered.value));
          if (usage === undefined) {
            yield* ledger.markUnknown(reservation);
            return yield* new TestdriveGuardError({
              code: "measurement-missing",
              detail: `Orbit response omitted complete token usage for ${reservation.model}`
            });
          }
          const snapshot = yield* ledger.reconcile(reservation, usage);
          if (reservation.pricing.priced) {
            outgoing = responseWithEstimatedCost(
              outgoing,
              estimateTestdriveCostUsd(reservation.pricing, usage.inputTokens, usage.outputTokens),
              usage
            );
          }
          yield* evidence.emit({
            type: "egress-reconciled",
            phase: "egress",
            model: reservation.model,
            callId: String(reservation.id),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            estimatedCostUsd: snapshot.estimatedCostUsd,
            status: String(upstream.status)
          });
        }
        return HttpServerResponse.uint8Array(outgoing, {
          status: upstream.status,
          contentType: upstream.headers.get("content-type") ?? contentType
        });
      }).pipe(
        Effect.catch((error) =>
          evidence
            .emit({
              type: "failure",
              phase: "egress",
              status: "failed",
              failureCode:
                error instanceof TestdriveGuardError ? error.code : "egress-proxy-failure"
            })
            .pipe(
              Effect.ignore,
              Effect.as(
                error instanceof TestdriveGuardError
                  ? publicGuardFailure(error)
                  : HttpServerResponse.jsonUnsafe(
                      {
                        error: {
                          type: "routekit_eval_testdrive_proxy_error",
                          message: "live eval-routing testdrive egress failed"
                        }
                      },
                      { status: 502 }
                    )
              )
            )
        )
      );
      const server = yield* NodeHttpServer.make(() => createServer(), {
        host: "127.0.0.1",
        port: 0
      }).pipe(
        Effect.mapError(
          () =>
            new TestdriveGuardError({
              code: "measurement-missing",
              detail: "failed to bind the local egress guard"
            })
        )
      );
      yield* server.serve(app);
      if (server.address._tag !== "TcpAddress") {
        return yield* new TestdriveGuardError({
          code: "measurement-missing",
          detail: "egress guard did not bind a TCP address"
        });
      }
      yield* Effect.addFinalizer(() =>
        evidence
          .emit({ type: "cleanup-finished", phase: "egress-guard", status: "closed" })
          .pipe(Effect.ignore)
      );
      return TestdriveEgressGuard.of({
        origin: `http://127.0.0.1:${String(server.address.port)}`
      });
    })
  );

export type TestdriveEgressGuardEnvironment =
  | HttpClient.HttpClient
  | Scope.Scope
  | TestdriveEvidence
  | TestdriveLedger;
