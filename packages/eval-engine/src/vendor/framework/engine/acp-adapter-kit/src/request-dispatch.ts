import { Effect } from "effect";

import type {
  AcpClientCorrelatedResult,
  AcpClientKnownRequest,
} from "../../../contracts/internal/src/acp/protocol/profile.ts";
import type { AcpClientRequestFailure } from "../../acp-agent/src/service.ts";

import type {
  SessionLoadParams,
  SessionPromptParams,
  SessionResumeParams,
} from "./session-requests.ts";

import { acpRequestFailure } from "./request-failure.ts";

// JSON-RPC METHOD_NOT_FOUND. Answered for the ACP methods both native-wire
// adapters decline, so a client gets a protocol-level refusal rather than a
// generic failure.
const METHOD_NOT_FOUND = -32_601;

type AcpRequestResult<R> = Effect.Effect<
  AcpClientCorrelatedResult,
  AcpClientRequestFailure,
  R
>;

/**
 * The five ACP client requests a native-wire adapter answers, as its own
 * handlers. `Context` is the adapter's private handler context, threaded through
 * untouched, so the dispatcher below never learns what a session is made of.
 */
export interface AcpRequestHandlerSet<Context, R = never> {
  readonly createSession: (context: Context) => AcpRequestResult<R>;
  /** An Effect value, not a thunk: the handshake result depends on no request. */
  readonly initializeResult: AcpRequestResult<R>;
  readonly loadSession: (
    context: Context,
    params: SessionLoadParams
  ) => AcpRequestResult<R>;
  readonly resumeSession: (
    context: Context,
    params: SessionResumeParams
  ) => AcpRequestResult<R>;
  readonly runPrompt: (
    context: Context,
    params: SessionPromptParams
  ) => AcpRequestResult<R>;
}

/**
 * Routes a decoded ACP client request to the adapter's handler for it.
 *
 * The declined set is closed on purpose: every `AcpClientKnownRequest` method is
 * either dispatched or explicitly refused, so adding a method to the contract
 * fails this switch's exhaustiveness rather than silently falling through to the
 * `Effect.die`, which is reachable only for a value that lied about its type.
 */
export const makeAcpRequestDispatcher =
  <Context, R = never>(
    handlers: AcpRequestHandlerSet<Context, R>
  ): ((
    context: Context,
    request: AcpClientKnownRequest
  ) => AcpRequestResult<R>) =>
  (context, request) => {
    switch (request.method) {
      case "initialize": {
        return handlers.initializeResult;
      }
      case "session/new": {
        return handlers.createSession(context);
      }
      case "session/load": {
        return handlers.loadSession(context, request.params);
      }
      case "session/resume": {
        return handlers.resumeSession(context, request.params);
      }
      case "session/prompt": {
        return handlers.runPrompt(context, request.params);
      }
      case "authenticate":
      case "logout":
      case "session/close":
      case "session/delete":
      case "session/list":
      case "session/set_config_option":
      case "session/set_mode": {
        return Effect.fail(
          acpRequestFailure(
            `ACP method is not supported: ${request.method}`,
            METHOD_NOT_FOUND
          )
        );
      }
      default: {
        return Effect.die("Unreachable ACP client request method");
      }
    }
  };
