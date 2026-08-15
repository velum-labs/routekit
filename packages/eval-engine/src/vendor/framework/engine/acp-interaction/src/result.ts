import type { AcpAgentCorrelatedResult } from "../../../contracts/internal/src/acp/protocol/profile.ts";
import type { AcpInboundRequestFailure } from "../../acp-client/src/service.ts";
import type { InteractionTerminal } from "../../interaction/src/model.ts";

/** JSON-RPC Request cancelled (ACP `$/cancel_request` completion marker). */
export const REQUEST_CANCELLED_CODE = -32_800;
/** JSON-RPC Invalid params. */
export const INVALID_PARAMS_CODE = -32_602;
/** JSON-RPC Internal error. */
export const INTERNAL_ERROR_CODE = -32_603;

export type InteractiveMethod =
  | "elicitation/create"
  | "session/request_permission";

export type MappedTerminal =
  | { readonly failure: AcpInboundRequestFailure; readonly type: "failure" }
  | { readonly result: AcpAgentCorrelatedResult; readonly type: "result" };

const asResult = (result: AcpAgentCorrelatedResult): MappedTerminal => ({
  result,
  type: "result",
});
const failure = (code: number, message: string): MappedTerminal => ({
  failure: {
    code,
    message,
  },
  type: "failure",
});

const cancelledRequest = failure(REQUEST_CANCELLED_CODE, "Request cancelled");
const invalidRequest = failure(
  INVALID_PARAMS_CODE,
  "The interactive request was invalid"
);
const peerExited = failure(INTERNAL_ERROR_CODE, "The peer exited");
const surfaceDisconnected = failure(
  INTERNAL_ERROR_CODE,
  "The presenting surface disconnected"
);

const mapPermission = (terminal: InteractionTerminal): MappedTerminal => {
  switch (terminal.state) {
    case "responded": {
      const { response } = terminal;
      if (response.kind !== "permission") {
        return failure(INTERNAL_ERROR_CODE, "Mismatched interaction response");
      }
      return asResult({
        method: "session/request_permission",
        result: {
          outcome:
            response.outcome === "selected"
              ? {
                  optionId: response.optionId,
                  outcome: "selected",
                }
              : { outcome: "cancelled" },
        },
      });
    }
    // session/cancel settles a pending permission as the successful protocol
    // `cancelled` outcome (RFC 0003, "Permission requests").
    case "cancelled-by-session": {
      return asResult({
        method: "session/request_permission",
        result: { outcome: { outcome: "cancelled" } },
      });
    }
    case "cancelled-by-request": {
      return cancelledRequest;
    }
    case "failed-invalid": {
      return invalidRequest;
    }
    case "failed-surface-disconnect": {
      return surfaceDisconnected;
    }
    case "failed-peer-exit": {
      return peerExited;
    }
    default: {
      return peerExited;
    }
  }
};

const mapElicitation = (terminal: InteractionTerminal): MappedTerminal => {
  switch (terminal.state) {
    case "responded": {
      const { response } = terminal;
      if (response.kind !== "elicitation") {
        return failure(INTERNAL_ERROR_CODE, "Mismatched interaction response");
      }
      if (response.action === "accept") {
        return asResult({
          method: "elicitation/create",
          result:
            response.content === undefined
              ? { action: "accept" }
              : {
                  action: "accept",
                  content: response.content,
                },
        });
      }
      return asResult({
        method: "elicitation/create",
        result: { action: response.action },
      });
    }
    // session/cancel dismisses a pending elicitation as the `cancel` action.
    case "cancelled-by-session": {
      return asResult({
        method: "elicitation/create",
        result: { action: "cancel" },
      });
    }
    case "cancelled-by-request": {
      return cancelledRequest;
    }
    case "failed-invalid": {
      return invalidRequest;
    }
    case "failed-surface-disconnect": {
      return surfaceDisconnected;
    }
    case "failed-peer-exit": {
      return peerExited;
    }
    default: {
      return peerExited;
    }
  }
};

/**
 * Translate a settled {@link InteractionTerminal} into the concrete ACP
 * response for the method that raised it: a `session/request_permission` or
 * `elicitation/create` result, or a typed {@link AcpInboundRequestFailure}. The
 * accept content flows through here into the wire result and nowhere else.
 */
export const terminalToResult = (
  method: InteractiveMethod,
  terminal: InteractionTerminal
): MappedTerminal =>
  method === "session/request_permission"
    ? mapPermission(terminal)
    : mapElicitation(terminal);

/** The deterministic no-surface fallback: a permission is never auto-approved. */
export const permissionFallback: AcpAgentCorrelatedResult = {
  method: "session/request_permission",
  result: { outcome: { outcome: "cancelled" } },
};

/** The deterministic no-surface fallback for a form elicitation: decline. */
export const elicitationFallback: AcpAgentCorrelatedResult = {
  method: "elicitation/create",
  result: { action: "decline" },
};
