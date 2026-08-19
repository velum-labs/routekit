import {
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { PROVIDER_IDS, type ProviderId, splitNamespacedModel } from "@velum-labs/routekit-config";
import { RouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { withCliClient } from "../../cli-client.js";
import {
  isLaunchProviderId,
  LAUNCH_PROVIDER_IDS,
  type LaunchProviderId
} from "../../launch-support.js";
import { routekitRoot } from "../root-command.js";

const optionalString = (name: string) =>
  Flag.string(name).pipe(
    Flag.optional,
    Flag.map(Option.getOrUndefined)
  );

function numberOption(value: string, label: string, input: { min: number; max: number }): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < input.min || parsed > input.max) {
    throw new Error(`${label} must be between ${input.min} and ${input.max}`);
  }
  return parsed;
}

function parseKnownProvider(value: string): ProviderId {
  if (!PROVIDER_IDS.includes(value as ProviderId)) {
    throw new Error(
      `unknown provider ${JSON.stringify(value)}; first-launch providers: ${LAUNCH_PROVIDER_IDS.join(", ")}`
    );
  }
  return value as ProviderId;
}

function parseLaunchProvider(value: string): LaunchProviderId {
  if (!isLaunchProviderId(value)) {
    throw new Error(
      `provider ${JSON.stringify(value)} is not offered at first launch; supported providers: ${LAUNCH_PROVIDER_IDS.join(", ")}`
    );
  }
  return value;
}

function rawProviders(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const makeProvidersCommand = (
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any => {
  const add = Command.make(
    "add",
    {
      provider: Argument.string("provider"),
      strategy: Flag.choice(
        "strategy",
        ["sticky", "round_robin", "capacity_weighted"] as const
      ).pipe(Flag.optional, Flag.map(Option.getOrUndefined)),
      switchThreshold: optionalString("switch-threshold").pipe(
        Flag.withDescription("proactive utilization threshold")
      ),
      probeInterval: optionalString("probe-interval").pipe(
        Flag.withDescription("usage probe interval")
      ),
      fallbackCooldown: optionalString("fallback-cooldown").pipe(
        Flag.withDescription("fallback cooldown")
      ),
      defaultModel: optionalString("default-model").pipe(
        Flag.withDescription("set the namespaced default model")
      )
    },
    (options) =>
      Effect.gen(function* () {
        const provider = parseLaunchProvider(options.provider);
        if (options.defaultModel !== undefined) {
          const selected = splitNamespacedModel(options.defaultModel);
          if (selected.provider !== provider) {
            return yield* Effect.fail(
              new Error(
                `default model "${options.defaultModel}" does not belong to provider "${provider}"`
              )
            );
          }
        }
        const policy = {
          ...(options.strategy !== undefined ? { strategy: options.strategy } : {}),
          ...(options.switchThreshold !== undefined
            ? {
                switchThreshold: numberOption(options.switchThreshold, "switch threshold", {
                  min: 0.01,
                  max: 1
                })
              }
            : {}),
          ...(options.probeInterval !== undefined
            ? {
                probeIntervalMs: numberOption(options.probeInterval, "probe interval", {
                  min: 0,
                  max: 86_400_000
                })
              }
            : {}),
          ...(options.fallbackCooldown !== undefined
            ? {
                fallbackCooldownSeconds: numberOption(
                  options.fallbackCooldown,
                  "fallback cooldown",
                  { min: 0, max: 86_400 }
                )
              }
            : {})
        };
        const updated = yield* withCliClient((client) =>
          Effect.gen(function* () {
            const current = yield* client.call("config.get", {});
            const draft = (parseYaml(current.document) ?? {}) as Record<string, unknown>;
            const configured = rawProviders(draft.providers);
            draft.providers = {
              ...configured,
              [provider]: {
                ...rawProviders(configured[provider]),
                ...policy
              }
            };
            if (options.defaultModel !== undefined) draft.defaultModel = options.defaultModel;
            return yield* client.call(
              "config.update",
              { expectedRevision: current.revision, document: stringifyYaml(draft) },
              { idempotencyKey: `provider-add-${provider}-${current.revision}` }
            );
          })
        );
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        if (ctx.json) {
          ctx.emit({ path: updated.path, provider, added: true, revision: updated.revision });
        } else {
          ctx.presenter.success(`enabled ${provider} in ${updated.path}`);
        }
      })
  ).pipe(Command.withDescription("enable a first-launch supported provider"));

  const remove = Command.make(
    "remove",
    { provider: Argument.string("provider") },
    ({ provider: value }) =>
      Effect.gen(function* () {
        const provider = parseKnownProvider(value);
        const updated = yield* withCliClient((client) =>
          Effect.gen(function* () {
            const current = yield* client.call("config.get", {});
            const draft = (parseYaml(current.document) ?? {}) as Record<string, unknown>;
            const configured = rawProviders(draft.providers);
            if (configured[provider] === undefined) {
              return yield* new RouteKitFailure({
                message: `provider is not configured: ${provider}`
              });
            }
            if (Object.keys(configured).length === 1) {
              return yield* new RouteKitFailure({
                message: "cannot remove the only configured provider"
              });
            }
            const next = { ...configured };
            delete next[provider];
            draft.providers = next;
            if (
              typeof draft.defaultModel === "string" &&
              draft.defaultModel.startsWith(`${provider}/`)
            ) {
              delete draft.defaultModel;
            }
            return yield* client.call(
              "config.update",
              { expectedRevision: current.revision, document: stringifyYaml(draft) },
              { idempotencyKey: `provider-remove-${provider}-${current.revision}` }
            );
          })
        );
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        if (ctx.json) {
          ctx.emit({ path: updated.path, provider, removed: true, revision: updated.revision });
        } else {
          ctx.presenter.success(`disabled ${provider} in ${updated.path}`);
        }
      })
  ).pipe(Command.withDescription("disable a provider"));

  const status = Command.make(
    "status",
    {
      provider: Argument.string("provider").pipe(
        Argument.optional,
        Argument.map(Option.getOrUndefined)
      )
    },
    ({ provider: value }) =>
      Effect.gen(function* () {
        const response = yield* withCliClient((client) =>
          client.call("providers.status", { live: true })
        );
        const statuses =
          value === undefined
            ? response.providers
            : response.providers.filter((entry) => entry.provider === parseKnownProvider(value));
        if (value !== undefined && statuses.length === 0) {
          return yield* Effect.fail(new Error(`provider is not configured: ${value}`));
        }
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        if (ctx.json) ctx.emit({ providers: statuses });
        else {
          for (const provider of statuses) {
            ctx.presenter.status(
              provider.credentialAvailable && provider.error === undefined ? "ok" : "fail",
              provider.provider,
              provider.error ??
                `${provider.models?.length ?? 0} live model(s); ${
                  provider.credentialAvailable ? "credential available" : "credential missing"
                }`
            );
          }
        }
        if (statuses.some((entry) => !entry.credentialAvailable || entry.error !== undefined)) {
          process.exitCode = 1;
        }
      })
  ).pipe(Command.withDescription("run live discovery for configured providers"));

  return Command.make("providers").pipe(
    Command.withDescription("manage explicit model providers"),
    Command.withSubcommands([add, remove, status])
  );
};
