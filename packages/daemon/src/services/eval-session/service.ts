import { createHash, randomBytes } from "node:crypto";

import type {
  EvalSessionLimits,
  EvalSessionPurpose,
  RouteKitControlResults
} from "@velum-labs/routekit-control";
import type { EffectRouteKitControlHandlers } from "@velum-labs/routekit-control/effect";
import type { EvalSessionAdmission, GatewayPrincipal } from "@velum-labs/routekit-gateway";
import { ControlError } from "@velum-labs/routekit-runtime/control";
import { Context, Effect, Layer } from "effect";

import { ActiveGateway } from "../active-gateway/service.js";
import { DaemonEnv } from "../../daemon-env-context.js";

type SessionState = {
  readonly id: string;
  readonly tokenDigest: string;
  readonly purpose: EvalSessionPurpose;
  readonly allowedModels: readonly string[];
  readonly limits: EvalSessionLimits;
  readonly expiresAtMs: number;
  calls: number;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  closed: boolean;
};

export type OpenEvalSessionInput = {
  purpose: EvalSessionPurpose;
  operationId: string;
  allowedModels: readonly string[];
  limits: EvalSessionLimits;
  expiresInSeconds: number;
  gatewayUrl: string;
  targetIdentity: string;
};

export type EvalSessionManagerOptions = {
  now?: () => number;
  random?: (bytes: number) => Buffer;
};

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Daemon-owned, memory-only registry for short-lived eval credentials. */
export class EvalSessionManager {
  readonly #sessions = new Map<string, SessionState>();
  readonly #sessionByTokenDigest = new Map<string, string>();
  readonly #now: () => number;
  readonly #random: (bytes: number) => Buffer;

  constructor(options: EvalSessionManagerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? randomBytes;
  }

  open(input: OpenEvalSessionInput): RouteKitControlResults["evalSession.open"] {
    const now = this.#now();
    const expiresAtMs = now + Math.min(input.expiresInSeconds * 1_000, input.limits.wallTimeMs);
    const sessionId = `eval_${this.#random(16).toString("base64url")}`;
    const credential = this.#random(32).toString("base64url");
    const tokenDigest = digest(credential);
    const session: SessionState = {
      id: sessionId,
      tokenDigest,
      purpose: input.purpose,
      allowedModels: [...input.allowedModels],
      limits: { ...input.limits },
      expiresAtMs,
      calls: 0,
      reservedInputTokens: 0,
      reservedOutputTokens: 0,
      closed: false
    };
    this.#sessions.set(sessionId, session);
    this.#sessionByTokenDigest.set(tokenDigest, sessionId);
    return {
      sessionId,
      gatewayUrl: input.gatewayUrl,
      bearerCredential: credential,
      targetIdentity: input.targetIdentity,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  close(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.closed) return false;
    session.closed = true;
    this.#sessionByTokenDigest.delete(session.tokenDigest);
    return true;
  }

  closeAll(): void {
    for (const session of this.#sessions.values()) session.closed = true;
    this.#sessionByTokenDigest.clear();
    this.#sessions.clear();
  }

  resolve(presented: string): GatewayPrincipal | undefined {
    const sessionId = this.#sessionByTokenDigest.get(digest(presented));
    if (sessionId === undefined) return undefined;
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.closed || this.#now() >= session.expiresAtMs) {
      if (session !== undefined) {
        session.closed = true;
        this.#sessionByTokenDigest.delete(session.tokenDigest);
      }
      return undefined;
    }
    return {
      id: session.id,
      label: `eval:${session.purpose}`,
      role: "eval",
      evalSession: {
        sessionId: session.id,
        allowedModels: session.allowedModels,
        expiresAt: new Date(session.expiresAtMs).toISOString(),
        perCallOutputTokens: session.limits.perCallOutputTokens,
        admit: (model, inputTokenUpperBound, requestedOutputTokens) =>
          this.#admit(session, model, inputTokenUpperBound, requestedOutputTokens)
      }
    };
  }

  #admit(
    session: SessionState,
    model: string,
    inputTokenUpperBound: number,
    requestedOutputTokens: number
  ): EvalSessionAdmission {
    if (session.closed) return { admitted: false, reason: "closed" };
    if (this.#now() >= session.expiresAtMs) {
      session.closed = true;
      this.#sessionByTokenDigest.delete(session.tokenDigest);
      return { admitted: false, reason: "expired" };
    }
    if (!session.allowedModels.includes(model)) {
      return { admitted: false, reason: "closed" };
    }
    if (session.calls >= session.limits.calls) {
      return { admitted: false, reason: "call_limit" };
    }
    if (
      !Number.isSafeInteger(inputTokenUpperBound) ||
      inputTokenUpperBound < 0 ||
      session.reservedInputTokens + inputTokenUpperBound > session.limits.inputTokens
    ) {
      return { admitted: false, reason: "input_limit" };
    }
    if (
      requestedOutputTokens > session.limits.perCallOutputTokens ||
      session.reservedOutputTokens + requestedOutputTokens > session.limits.outputTokens
    ) {
      return { admitted: false, reason: "output_limit" };
    }
    session.calls += 1;
    session.reservedInputTokens += inputTokenUpperBound;
    session.reservedOutputTokens += requestedOutputTokens;
    return { admitted: true };
  }
}

export class EvalSessions extends Context.Service<EvalSessions, EvalSessionManager>()(
  "@velum-labs/routekit-daemon/EvalSessions"
) {
  static layer(options: EvalSessionManagerOptions = {}) {
    return Layer.effect(
      EvalSessions,
      Effect.acquireRelease(
        Effect.sync(() => new EvalSessionManager(options)),
        (sessions) => Effect.sync(() => sessions.closeAll())
      )
    );
  }
}

type EvalSessionHandlers = Pick<
  EffectRouteKitControlHandlers,
  "evalSession.open" | "evalSession.close"
>;

/** Owns short-lived, model-restricted eval data-plane sessions. */
export class EvalSessionApplicationService {
  handlers(): EvalSessionHandlers {
    return {
      "evalSession.open": (params) =>
        Effect.gen(function* () {
          const env = yield* DaemonEnv;
          const gateway = yield* ActiveGateway;
          const sessions = yield* EvalSessions;
          const gatewayUrl = gateway.dataUrl();
          if (gatewayUrl === undefined) {
            return yield* Effect.fail(
              new ControlError({
                code: "unavailable",
                message: "eval session cannot open before the data gateway is ready"
              })
            );
          }
          return sessions.open({
            ...params,
            gatewayUrl,
            targetIdentity: `routekit-generation:${env.generation}`
          });
        }),
      "evalSession.close": (params) =>
        Effect.gen(function* () {
          const sessions = yield* EvalSessions;
          return {
            sessionId: params.sessionId,
            closed: sessions.close(params.sessionId)
          };
        })
    };
  }
}
