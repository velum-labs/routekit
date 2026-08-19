import {
  CliError,
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import type { RouteKitCallInspection } from "@velum-labs/routekit-control";
import { formatUsd } from "@velum-labs/routekit-gateway";
import { ControlError } from "@velum-labs/routekit-runtime/control";
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";

import { withCliClient } from "../../cli-client.js";
import { routekitRoot } from "../root-command.js";

function usageText(call: RouteKitCallInspection): string {
  const usage = call.usage;
  if (usage === undefined) return "not reported";
  return [
    usage.prompt_tokens !== undefined ? `input=${usage.prompt_tokens}` : undefined,
    usage.completion_tokens !== undefined ? `output=${usage.completion_tokens}` : undefined,
    usage.total_tokens !== undefined ? `total=${usage.total_tokens}` : undefined
  ]
    .filter((value): value is string => value !== undefined)
    .join(", ");
}

function costText(call: RouteKitCallInspection): string {
  if (call.cost.estimateUsd !== undefined) {
    return `${formatUsd(call.cost.estimateUsd)} estimated`;
  }
  return call.cost.unknownCost ? "unknown" : "$0.00 estimated";
}

export const makeCallsCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any => {
  const inspect = Command.make(
    "inspect",
    { callId: Argument.string("call-id") },
    ({ callId }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const call = yield* withCliClient((client) =>
          client.call("calls.inspect", { callId })
        ).pipe(
          Effect.catch((error) =>
            error instanceof ControlError && error.code === "not_found"
              ? Effect.fail(
                  new CliError({
                    code: "call_not_found",
                    message: `model call is unknown or expired: ${callId}`,
                    hint: "Call attribution is retained by the current daemon for a bounded period.",
                    tryCommand: "routekit status"
                  })
                )
              : Effect.fail(error)
          )
        );
        if (ctx.json) {
          ctx.emit(call);
          return;
        }
        const lines = [
          ["call", call.callId],
          ["status", call.status],
          ...(call.requestedModel === undefined ? [] : [["requested model", call.requestedModel]]),
          ["effective model", call.effectiveModel],
          ...(call.nativeModel !== undefined ? [["native model", call.nativeModel]] : []),
          ["provider", call.provider],
          ["account / seat", call.account?.seat ?? "not applicable"],
          [
            "principal",
            call.principal === undefined
              ? "not applicable"
              : call.principal.label !== undefined
                ? `${call.principal.label} (${call.principal.tokenId})`
                : call.principal.tokenId
          ],
          ["billing mode", call.billingMode],
          ...(call.compositionalRouting === undefined
            ? []
            : [
                ["auto selected model", call.compositionalRouting.selectedModel],
                ["auto evidence", call.compositionalRouting.evidenceDigest],
                [
                  "auto dimension weights",
                  call.compositionalRouting.weights
                    .map((entry) => `${entry.dimensionId}=${entry.weight.toFixed(4)}`)
                    .join(", ")
                ],
                ["auto unknown weight", call.compositionalRouting.unknownWeight.toFixed(4)],
                ...(call.compositionalRouting.classifierCallId === undefined
                  ? []
                  : [["auto classifier call", call.compositionalRouting.classifierCallId]])
              ]),
          ...(call.eval === undefined
            ? []
            : [
                ["eval role", call.eval.role],
                ["eval run", call.eval.runId],
                ["eval bypass", call.eval.policyBypass ? "active" : "inactive"]
              ]),
          [
            "retries",
            `${call.retries.total} (${call.retries.accountFailovers} account failovers, ${call.retries.attempts} attempts)`
          ],
          ["usage", usageText(call) || "not reported"],
          ["cost", costText(call)],
          ["started", call.timing.startedAt],
          ...(call.timing.finishedAt !== undefined ? [["finished", call.timing.finishedAt]] : [])
        ] as unknown as ReadonlyArray<readonly [string, string]>;
        for (const [label, value] of lines) ctx.presenter.line(`${label}: ${value}`);
      })
  ).pipe(
    Command.withDescription("show routing, billing, retry, usage, and cost attribution")
  );

  return Command.make("calls").pipe(
    Command.withDescription("inspect recent model calls"),
    Command.withSubcommands([inspect])
  );
};
