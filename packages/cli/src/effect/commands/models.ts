import {
  CliError,
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import type { ModelRouteInfo } from "@velum-labs/routekit-control";
import { ControlError } from "@velum-labs/routekit-runtime/control";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { fetchLiveCatalog } from "../../catalog.js";
import { withCliClient } from "../../cli-client.js";
import { cliTryPromise } from "../../cli-session.js";
import { routekitClient } from "../../client.js";
import { resolveTarget } from "../../target.js";
import { routekitRoot } from "../root-command.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isModelRouteInfo(value: unknown): value is ModelRouteInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.provider === "string" &&
    typeof value.nativeModel === "string" &&
    ["api-key", "subscription", "proxy"].includes(String(value.accountClass)) &&
    ["metered-api", "subscription", "upstream-managed"].includes(String(value.billingMode)) &&
    typeof value.default === "boolean" &&
    isRecord(value.capabilities) &&
    (value.reasoning === null || isRecord(value.reasoning))
  );
}

const optionalString = (name: string) =>
  Flag.string(name).pipe(
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  );

export const makeModelsCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any => {
  const providerFor = (model: { id: string; provider?: string }): string =>
    model.provider ?? model.id.split("/", 1)[0] ?? "unknown";
  const shouldRenderTable = (): boolean =>
    "isTTY" in runtime.stdout && runtime.stdout.isTTY === true;

  const listEffect = (provider: string | undefined) =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const target = yield* cliTryPromise(() => resolveTarget());
      const catalog =
        target.kind === "remote"
          ? yield* fetchLiveCatalog(target.remote.gatewayUrl, {
              authToken: target.authToken
            })
          : yield* Effect.gen(function* () {
              const client = yield* routekitClient;
              return yield* client.call("models.list", {
                ...(provider !== undefined ? { provider } : {})
              });
            });
      const filtered = catalog.models.filter(
        (model) => provider === undefined || providerFor(model) === provider
      );
      const modelIds = filtered.map((model) => model.id);
      if (ctx.json) {
        ctx.emit({
          defaultModel: catalog.defaultModel,
          models: modelIds,
          catalog: filtered
        });
      } else if (shouldRenderTable()) {
        ctx.presenter.table(
          filtered.map((model) => [
            providerFor(model),
            model.id,
            model.id === catalog.defaultModel ? "default" : ""
          ]),
          { head: ["provider", "model", ""] }
        );
      } else {
        for (const model of modelIds) runtime.stdout.write(`${model}\n`);
      }
    });

  const list = Command.make(
    "list",
    {
      provider: optionalString("provider").pipe(
        Flag.withDescription("only show models from one provider")
      )
    },
    ({ provider }) => listEffect(provider)
  ).pipe(Command.withDescription("discover live namespaced model ids"));

  const info = Command.make(
    "info",
    { id: Argument.string("id") },
    ({ id }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const model = yield* withCliClient((client) =>
          client.call("models.info", { model: id })
        ).pipe(
          Effect.catch((error) =>
            error instanceof ControlError && error.code === "not_found"
              ? Effect.fail(
                  new CliError({
                    code: "model_not_found",
                    message: `model is not in the live catalog: ${id}`,
                    tryCommand: "routekit models list"
                  })
                )
              : Effect.fail(error)
          )
        );
        if (!isModelRouteInfo(model)) {
          return yield* Effect.fail(
            new CliError({
              code: "daemon_upgrade_required",
              message: "the running RouteKit daemon does not support the route explanation contract",
              tryCommand: "routekit daemon upgrade --force"
            })
          );
        }
        if (ctx.json) {
          ctx.emit(model);
          return;
        }
        ctx.presenter.heading(model.id);
        ctx.presenter.keyValue([
          { label: "provider", value: model.provider },
          { label: "native model", value: model.nativeModel },
          { label: "account class", value: model.accountClass },
          { label: "billing mode", value: model.billingMode },
          { label: "default", value: model.default ? "yes" : "no" },
          {
            label: "capabilities",
            value:
              Object.entries(model.capabilities ?? {})
                .map(([name, value]) => `${name}=${value}`)
                .join(", ") || "not reported"
          },
          {
            label: "reasoning",
            value: model.reasoning === null ? "not reported" : JSON.stringify(model.reasoning)
          }
        ]);
      })
  ).pipe(Command.withDescription("show metadata and capabilities for one live model"));

  return Command.make("models", {}, () => listEffect(undefined)).pipe(
    Command.withDescription("inspect models"),
    Command.withSubcommands([list, info])
  );
};
