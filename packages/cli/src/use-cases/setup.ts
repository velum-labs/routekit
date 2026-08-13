import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import {
  type CliRuntime,
  type CommandContext,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import type { Back, SelectOption, WizardStep } from "@velum-labs/routekit-cli-ui";
import { confirm, fuzzySelect, multiselect, runWizard, text } from "@velum-labs/routekit-cli-ui";
import { type ProviderId, parseRouterConfig, type RouterConfig } from "@velum-labs/routekit-config";
import { type ProviderSource, RoutingBackend } from "@velum-labs/routekit-gateway";
import { catalogDefaultModel, PROVIDERS, subscriptionInfo } from "@velum-labs/routekit-registry";
import {
  acquireLifecycleLock,
  supervisorController,
  supervisorOperationTimeoutMs,
  waitForProcessExit
} from "@velum-labs/routekit-runtime";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runCliEffect } from "../cli-session.js";
import {
  controlClientForRecord,
  daemonLifecycleLockPath,
  ensureDaemon,
  readDaemonRecord,
  routekitClient
} from "../client.js";
import { globalRouterConfigPath, loadRouterConfig, writeRouterConfig } from "../config.js";
import { missingServiceCredentialVariables } from "../daemon.js";
import type { LaunchAccountKind, LaunchProviderId } from "../launch-support.js";
import { redactSensitiveText } from "../ssh-exec.js";
import { LoginAndActivateSubscription } from "./accounts.js";

export const SETUP_API_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "openrouter",
  "bedrock"
] as const satisfies readonly LaunchProviderId[];

export const SETUP_SUBSCRIPTION_IDS = [
  "codex",
  "claude-code"
] as const satisfies readonly LaunchAccountKind[];

export type SetupApiProviderId = (typeof SETUP_API_PROVIDER_IDS)[number];
export type SetupSubscriptionId = (typeof SETUP_SUBSCRIPTION_IDS)[number];
export type SetupRouteId = SetupApiProviderId | SetupSubscriptionId;

const ROUTE_LABELS: Readonly<Record<SetupRouteId, string>> = {
  openai: "OpenAI API",
  anthropic: "Anthropic API",
  openrouter: "OpenRouter API",
  bedrock: "Amazon Bedrock",
  codex: "Codex subscription",
  "claude-code": "Claude Code subscription"
};

const API_BILLING_OWNERS: Readonly<Record<SetupApiProviderId, string>> = {
  openai: "OpenAI API account",
  anthropic: "Anthropic API account",
  openrouter: "OpenRouter account",
  bedrock: "AWS account"
};

const SUBSCRIPTION_CREDENTIAL_TYPES: Readonly<Record<SetupSubscriptionId, string>> = {
  codex: "official Codex OAuth",
  "claude-code": "official Claude login"
};

const SETUP_ROUTE_OPTIONS: ReadonlyArray<SelectOption<SetupRouteId>> = [
  ...SETUP_API_PROVIDER_IDS.map((provider) => ({
    value: provider,
    label: ROUTE_LABELS[provider],
    hint: `${credentialDescription(provider)} · ${API_BILLING_OWNERS[provider]} billing`
  })),
  ...SETUP_SUBSCRIPTION_IDS.map((subscription) => ({
    value: subscription,
    label: ROUTE_LABELS[subscription],
    hint:
      `${SUBSCRIPTION_CREDENTIAL_TYPES[subscription]} · ` +
      `${subscriptionInfo(subscription).provider} subscription billing`
  }))
];

function isApiProvider(value: SetupRouteId): value is SetupApiProviderId {
  return (SETUP_API_PROVIDER_IDS as readonly string[]).includes(value);
}

function isSubscription(value: SetupRouteId): value is SetupSubscriptionId {
  return (SETUP_SUBSCRIPTION_IDS as readonly string[]).includes(value);
}

function providerRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function setupCandidateConfig(apiProviders: readonly SetupApiProviderId[]): RouterConfig {
  return parseRouterConfig({
    providers: Object.fromEntries(apiProviders.map((provider) => [provider, {}]))
  });
}

export function credentialDescription(provider: SetupApiProviderId): string {
  if (provider === "bedrock") return "AWS SDK default credential and region chains";
  const info = PROVIDERS[provider];
  const variables = [info?.keyEnv, info?.authTokenEnv].filter(
    (value): value is string => value !== undefined
  );
  return variables.join(" or ");
}

function providerCredentialValues(
  providers: readonly ProviderId[],
  env: Readonly<NodeJS.ProcessEnv> = processCliRuntime.env
): string[] {
  const names = new Set<string>();
  for (const provider of providers) {
    const info = PROVIDERS[provider];
    for (const name of [info?.keyEnv, info?.authTokenEnv, ...(info?.credentialEnvNames ?? [])]) {
      if (name !== undefined) names.add(name);
    }
    if (provider === "bedrock") {
      for (const name of [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN"
      ]) {
        names.add(name);
      }
    }
  }
  return [...names].flatMap((name) => {
    const value = env[name];
    return value === undefined || value.length === 0 ? [] : [value];
  });
}

function safeSetupError(
  error: unknown,
  providers: readonly ProviderId[],
  env: Readonly<NodeJS.ProcessEnv> = processCliRuntime.env
): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message, providerCredentialValues(providers, env));
}

function existingConfigRecovery(config: RouterConfig): string {
  const providers = Object.keys(config.providers) as ProviderId[];
  const commands = providers.flatMap((provider) => {
    if (provider === "bedrock") {
      return ["AWS_PROFILE=<profile> AWS_REGION=<region> routekit setup"];
    }
    const variable = PROVIDERS[provider]?.keyEnv ?? PROVIDERS[provider]?.authTokenEnv;
    return variable === undefined ? [] : [`${variable}=<credential> routekit setup`];
  });
  return commands.length > 0
    ? commands.join(" or ")
    : "routekit accounts login <subscription-kind> --name <label>";
}

export type SetupPreflightResult = {
  provider: SetupApiProviderId;
  models: string[];
};

export async function preflightSetupApiProvider(
  provider: SetupApiProviderId,
  options: { env?: NodeJS.ProcessEnv; source?: ProviderSource } = {}
): Promise<SetupPreflightResult> {
  const env = options.env ?? processCliRuntime.env;
  const config = setupCandidateConfig([provider]);
  const missing = missingServiceCredentialVariables(config, env);
  if (missing.length > 0) {
    throw new Error(`set ${missing.join(" or ")}`);
  }
  let backend: RoutingBackend | undefined;
  try {
    backend = await RoutingBackend.create({
      config,
      env,
      ...(options.source !== undefined ? { sources: { [provider]: options.source } } : {})
    });
    const response = await backend.models();
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const models = (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string");
    if (models.length === 0) {
      throw new Error(`provider "${provider}" discovery returned no models`);
    }
    return { provider, models };
  } catch (error) {
    throw new Error(safeSetupError(error, [provider], env));
  } finally {
    await backend?.close();
  }
}

export function preferredModelOptions(
  models: ReadonlyArray<{ id: string }>,
  input: {
    currentDefault?: string;
    firstSelectedRoute?: SetupRouteId;
  }
): Array<SelectOption<string>> {
  const unique = [...new Map(models.map((model) => [model.id, model])).values()];
  const preferred =
    input.currentDefault !== undefined && unique.some((model) => model.id === input.currentDefault)
      ? input.currentDefault
      : input.firstSelectedRoute !== undefined
        ? (() => {
            const nativeDefault = isSubscription(input.firstSelectedRoute)
              ? subscriptionInfo(input.firstSelectedRoute).defaultModel
              : catalogDefaultModel(input.firstSelectedRoute);
            const candidate =
              nativeDefault === undefined
                ? undefined
                : `${input.firstSelectedRoute}/${nativeDefault}`;
            return candidate !== undefined && unique.some((model) => model.id === candidate)
              ? candidate
              : undefined;
          })()
        : undefined;
  const ordered =
    preferred === undefined
      ? unique
      : [
          unique.find((model) => model.id === preferred)!,
          ...unique.filter((model) => model.id !== preferred)
        ];
  return ordered.map((model) => {
    const provider = model.id.split("/", 1)[0] ?? "";
    return {
      value: model.id,
      label: model.id,
      hint:
        provider === "codex" || provider === "claude-code"
          ? "subscription"
          : provider === "bedrock"
            ? "AWS account"
            : "API account"
    };
  });
}

type SetupAnswers = {
  routes: SetupRouteId[];
  codexLabel?: string;
  claudeLabel?: string;
  confirmed: boolean;
};

async function collectSetupAnswers(input: {
  availableRoutes: ReadonlyArray<SelectOption<SetupRouteId>>;
  allowNoRoutes: boolean;
}): Promise<SetupAnswers> {
  const steps: Array<WizardStep<SetupAnswers>> = [
    {
      id: "routes",
      title: "routes",
      run: async (state) => ({
        ...state,
        routes: await multiselect({
          message: input.allowNoRoutes
            ? "Add subscription routes"
            : "Select the routes RouteKit should configure",
          options: input.availableRoutes,
          defaultSelected: input.availableRoutes.flatMap((option, index) =>
            state.routes.includes(option.value) ? [index] : []
          )
        })
      }),
      skip: () => input.availableRoutes.length === 0
    },
    {
      id: "codex-label",
      title: "Codex account",
      skip: (state) => !state.routes.includes("codex"),
      run: async (state) => {
        const label = await text({
          message: "Codex account label",
          defaultValue: state.codexLabel ?? "personal",
          allowBack: true
        });
        if (typeof label !== "string") return label;
        if (label.trim().length === 0) throw new Error("account label cannot be empty");
        return { ...state, codexLabel: label.trim() };
      }
    },
    {
      id: "claude-label",
      title: "Claude Code account",
      skip: (state) => !state.routes.includes("claude-code"),
      run: async (state) => {
        const label = await text({
          message: "Claude Code account label",
          defaultValue: state.claudeLabel ?? "personal",
          allowBack: true
        });
        if (typeof label !== "string") return label;
        if (label.trim().length === 0) throw new Error("account label cannot be empty");
        return { ...state, claudeLabel: label.trim() };
      }
    },
    {
      id: "confirm",
      title: "confirm",
      skip: (state) => state.routes.length === 0,
      run: async (state) => {
        const accepted = await confirm({
          message: `Configure ${state.routes.join(", ")}?`,
          defaultValue: true,
          allowBack: true
        });
        if (typeof accepted !== "boolean") return accepted as Back;
        return { ...state, confirmed: accepted };
      }
    }
  ];
  return await runWizard({
    steps,
    initial: { routes: [], confirmed: input.allowNoRoutes }
  });
}

async function stopDaemonForEmptyReconfiguration(): Promise<void> {
  const record = readDaemonRecord();
  if (record === undefined) return;
  if (record.supervisor === "systemd" || record.supervisor === "launchd") {
    await supervisorController(record.supervisor, "routekit", "daemon").stop({
      timeoutMs: supervisorOperationTimeoutMs(record.drainGraceMs)
    });
  } else {
    await runCliEffect(
      controlClientForRecord(record).call(
        "daemon.prepareShutdown",
        { reason: "restart" },
        { idempotencyKey: `setup-stop-${record.generation ?? record.pid}` }
      )
    );
  }
  const stopped = await waitForProcessExit(
    record.pid,
    supervisorOperationTimeoutMs(record.drainGraceMs),
    record.processIdentity
  );
  if (!stopped) throw new Error(`RouteKit daemon pid ${record.pid} did not stop`);
}

function setupConfigIdempotencyKey(revision: number, document: string): string {
  const fingerprint = createHash("sha256")
    .update(String(revision))
    .update("\0")
    .update(document)
    .digest("hex")
    .slice(0, 24);
  return `setup-config-${revision}-${fingerprint}`;
}

export class SetupRouteKit {
  constructor(private readonly loginAndActivateSubscription = new LoginAndActivateSubscription()) {}

  async execute(input: {
    browser?: boolean;
    context: CommandContext;
    runtime: CliRuntime;
  }): Promise<void> {
    const options = { browser: input.browser };
    const ctx = input.context;
    if (ctx.json || ctx.noInput) {
      throw new Error(
        "`setup` is interactive and does not support --json or --no-input; " +
          "use `config init`, `providers add`, and `accounts login` for automation"
      );
    }
    const configPath = globalRouterConfigPath();
    const configExists = existsSync(configPath);
    const existing = configExists ? loadRouterConfig({ configPath }).config : undefined;
    const existingProviders = Object.keys(existing?.providers ?? {}) as ProviderId[];
    const emptyBootstrap = existing === undefined || existingProviders.length === 0;
    const availableRoutes = emptyBootstrap
      ? SETUP_ROUTE_OPTIONS
      : SETUP_ROUTE_OPTIONS.filter(
          (option) =>
            isSubscription(option.value) && existing?.providers[option.value] === undefined
        );
    if (!emptyBootstrap) {
      ctx.presenter.note(`preserving existing providers: ${existingProviders.join(", ")}`);
      const missing = missingServiceCredentialVariables(existing);
      if (missing.length > 0) {
        throw new Error(
          `existing config cannot start: set ${missing.join(" or ")}; ` +
            `then rerun \`${existingConfigRecovery(existing)}\``
        );
      }
    }

    const answers = await collectSetupAnswers({
      availableRoutes,
      allowNoRoutes: !emptyBootstrap
    });
    if (!answers.confirmed) {
      ctx.presenter.note("setup canceled; no changes made");
      return;
    }
    if (emptyBootstrap && answers.routes.length === 0) {
      throw new Error("select at least one route");
    }

    const selectedApiProviders = answers.routes.filter(isApiProvider);
    if (selectedApiProviders.length > 0) {
      ctx.presenter.note("checking selected API providers before writing config");
      const failures: string[] = [];
      for (const provider of selectedApiProviders) {
        try {
          const result = await preflightSetupApiProvider(provider, { env: input.runtime.env });
          ctx.presenter.success(
            `${provider}: authenticated; ${result.models.length} live model(s)`
          );
        } catch (error) {
          failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `setup preflight failed; no configuration changes were made:\n${failures.join("\n")}`
        );
      }
    }

    let client;
    if (emptyBootstrap) {
      const candidate = setupCandidateConfig(selectedApiProviders);
      const lock = await acquireLifecycleLock(daemonLifecycleLockPath(), {
        timeoutMs: 90_000
      });
      try {
        await stopDaemonForEmptyReconfiguration();
        writeRouterConfig(configPath, candidate);
        client = (
          await ensureDaemon({
            configPath,
            lifecycleLockHeld: true
          })
        ).client;
      } finally {
        lock.release();
      }
      ctx.presenter.success(`initialized ${configPath}`);
    } else {
      try {
        client = await routekitClient();
      } catch (error) {
        throw new Error(
          `existing config could not start: ${safeSetupError(error, existingProviders)}; ` +
            `recovery: \`${existingConfigRecovery(existing)}\``
        );
      }
    }

    const noBrowser = options.browser === false;
    for (const subscription of answers.routes.filter(isSubscription)) {
      const label = subscription === "codex" ? answers.codexLabel : answers.claudeLabel;
      if (label === undefined) {
        throw new Error(`missing account label for ${subscription}`);
      }
      if (noBrowser && subscription === "claude-code") {
        ctx.presenter.note(
          "Claude Code will print a copyable login URL and accept the code in this terminal"
        );
      }
      const result = await this.loginAndActivateSubscription.execute({
        client,
        kind: subscription,
        label,
        ...(noBrowser ? { noBrowser: true } : {})
      });
      ctx.presenter.success(`logged in, enrolled, and enabled ${result.kind}/${result.label}`);
    }

    const listed = await runCliEffect(client.call("models.list", {}));
    if (listed.models.length === 0) {
      throw new Error("setup completed no usable route: live discovery returned no models");
    }
    const currentConfig = await runCliEffect(client.call("config.get", {}));
    const raw = providerRecord(parseYaml(currentConfig.document));
    const currentDefault = typeof raw.defaultModel === "string" ? raw.defaultModel : undefined;
    const modelOptions = preferredModelOptions(listed.models, {
      ...(currentDefault !== undefined ? { currentDefault } : {}),
      ...(answers.routes[0] !== undefined ? { firstSelectedRoute: answers.routes[0] } : {})
    });
    const defaultModel = await fuzzySelect({
      message: "Choose the default model",
      options: modelOptions,
      placeholder: "Filter live models"
    });
    raw.defaultModel = defaultModel;
    const document = stringifyYaml(raw);
    await runCliEffect(
      client.call(
        "config.update",
        {
          expectedRevision: currentConfig.revision,
          document
        },
        {
          idempotencyKey: setupConfigIdempotencyKey(currentConfig.revision, document)
        }
      )
    );

    const [status, providers, model] = await Promise.all([
      runCliEffect(client.call("daemon.status", {})),
      runCliEffect(client.call("providers.status", { live: true })),
      runCliEffect(client.call("models.info", { model: defaultModel }))
    ]);
    const failedProviders = providers.providers.filter(
      (entry) =>
        !entry.credentialAvailable || entry.error !== undefined || (entry.models?.length ?? 0) === 0
    );
    if (failedProviders.length > 0) {
      throw new Error(
        "setup verification failed: " +
          failedProviders
            .map(
              (entry) =>
                `${entry.provider}: ${
                  entry.error === undefined
                    ? "no live models available"
                    : safeSetupError(entry.error, [entry.provider as ProviderId])
                }`
            )
            .join("; ")
      );
    }
    const routeDetails = await Promise.all(
      providers.providers.map(async (entry) => {
        const routeModel = entry.models?.[0];
        if (routeModel === undefined) {
          throw new Error(`${entry.provider}: no live model available`);
        }
        const info =
          routeModel === defaultModel
            ? model
            : await runCliEffect(client.call("models.info", { model: routeModel }));
        return `${entry.provider} (${info.billingMode})`;
      })
    );
    ctx.presenter.success("RouteKit setup is complete");
    ctx.presenter.keyValue([
      { label: "Gateway", value: status.dataUrl },
      {
        label: "Routes",
        value: routeDetails.join(", ")
      },
      { label: "Default model", value: defaultModel },
      { label: "Default billing", value: model.billingMode }
    ]);
    ctx.presenter.note("next: `routekit status` or `routekit models list`");
  }
}
