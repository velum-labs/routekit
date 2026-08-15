import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { type CliRuntime, contextFor, processCliRuntime } from "@velum-labs/routekit-cli-core";
import {
  parseRouterConfig,
  type RouterConfig,
  splitNamespacedModel
} from "@velum-labs/routekit-config";
import { catalogDefaultModel } from "@velum-labs/routekit-registry";
import { acquireLifecycleLock } from "@velum-labs/routekit-runtime";
import { RouteKitFailure, toRouteKitFailure } from "@velum-labs/routekit-runtime/effect";
import { type Command, Option } from "commander";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { runCliClient } from "../cli-client.js";
import { cliTry, cliTryPromise, runCliEffect } from "../cli-session.js";
import { Effect } from "effect";
import {
  connectDaemon,
  daemonLifecycleLockPath,
  ensureDaemon,
  readDaemonRecord,
  routekitClient
} from "../client.js";
import { DEFAULT_ROUTER_CONFIG, globalRouterConfigPath, writeRouterConfig } from "../config.js";
import { missingServiceCredentialVariables } from "../daemon.js";
import { configImportIdempotencyKey, ImportRouterConfig } from "../use-cases/config.js";

export const CONFIG_INIT_PROVIDER_IDS = ["openai", "anthropic", "openrouter", "bedrock"] as const;

export type ConfigInitProviderId = (typeof CONFIG_INIT_PROVIDER_IDS)[number];

export type ConfigInitOptions = {
  provider?: ConfigInitProviderId;
  defaultModel?: string;
  empty?: boolean;
};

export function configInitRouterConfig(input: ConfigInitOptions = {}): RouterConfig {
  if (input.empty === true) return parseRouterConfig({ providers: {} });
  if (input.provider === undefined) {
    if (input.defaultModel !== undefined) {
      throw new Error("--default-model requires --provider");
    }
    return DEFAULT_ROUTER_CONFIG;
  }
  const registeredDefault = catalogDefaultModel(input.provider);
  const defaultModel =
    input.defaultModel ??
    (registeredDefault !== undefined ? `${input.provider}/${registeredDefault}` : undefined);
  if (input.provider === "bedrock" && defaultModel === undefined) {
    throw new Error(
      "`config init --provider bedrock` requires " +
        "`--default-model bedrock/<approved-model-or-inference-profile>`"
    );
  }
  if (defaultModel !== undefined) {
    const selected = splitNamespacedModel(defaultModel);
    if (selected.provider !== input.provider) {
      throw new Error(
        `default model "${defaultModel}" does not belong to provider "${input.provider}"`
      );
    }
  }
  return parseRouterConfig({
    providers: { [input.provider]: {} },
    ...(defaultModel !== undefined ? { defaultModel } : {})
  });
}

export function configInitIdempotencyKey(input: {
  revision: number;
  config: RouterConfig;
}): string {
  const fingerprint = createHash("sha256")
    .update(String(input.revision))
    .update("\0")
    .update(stringifyYaml(input.config))
    .digest("hex")
    .slice(0, 24);
  return `config-init-${input.revision}-${fingerprint}`;
}

export { configImportIdempotencyKey };

export function registerConfig(program: Command, runtime: CliRuntime = processCliRuntime): void {
  const config = program.command("config").description("manage router configuration");
  const importRouterConfig = new ImportRouterConfig();

  config
    .command("path")
    .description("print the canonical singleton router config path")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command, runtime);
      const path = (await runCliClient((client) => client.call("config.get", {}))).path;
      if (ctx.json) ctx.emit({ path, exists: existsSync(path) });
      else runtime.stdout.write(`${path}\n`);
    });

  config
    .command("show")
    .description("show the validated canonical singleton router config")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command, runtime);
      const result = await runCliClient((client) => client.call("config.get", {}));
      if (ctx.json) {
        ctx.emit({
          path: result.path,
          revision: result.revision,
          config: parseYaml(result.document)
        });
      } else runtime.stdout.write(result.document);
    });

  const init = config
    .command("init")
    .description("create the canonical singleton router config")
    .addOption(new Option("--global").hideHelp())
    .addOption(
      new Option(
        "--provider <provider>",
        `API provider starter (${CONFIG_INIT_PROVIDER_IDS.join(", ")})`
      )
        .choices([...CONFIG_INIT_PROVIDER_IDS])
        .conflicts("empty")
    )
    .addOption(
      new Option(
        "--default-model <provider/model>",
        "set the starter's namespaced default model"
      ).conflicts("empty")
    )
    .addOption(
      new Option(
        "--empty",
        "create an empty config before enrolling subscription accounts"
      ).conflicts(["provider", "defaultModel"])
    )
    .option("--force", "replace an existing config");

  init.addHelpText(
    "after",
    [
      "",
      "Provider credentials:",
      "  openai      OPENAI_API_KEY",
      "  anthropic   ANTHROPIC_API_KEY",
      "  openrouter  OPENROUTER_API_KEY",
      "  bedrock     AWS SDK default credential and region chains",
      "",
      "Use --empty before `routekit accounts login codex|claude-code --name <label>`.",
      "For guided multi-route onboarding, run `routekit setup`."
    ].join("\n")
  );

  init.action(async (options: ConfigInitOptions & { force?: boolean }, command: Command) => {
    const ctx = contextFor(command, runtime);
    const path = globalRouterConfigPath();
    const starterConfig = configInitRouterConfig(options);
    const missingCredentials = missingServiceCredentialVariables(starterConfig);
    const providers = Object.keys(starterConfig.providers);
    const nextSteps =
      missingCredentials.length > 0
        ? [`set ${missingCredentials.join(" or ")}`, "run `routekit start`"]
        : providers.length === 0
          ? [
              "run `routekit accounts login codex --name <label>` or " +
                "`routekit accounts login claude-code --name <label>`"
            ]
          : ["run `routekit providers status`", "run `routekit models list`"];
    if (existsSync(path) && options.force !== true) {
      throw new Error(`${path} already exists (pass --force to replace it)`);
    }
    if (readDaemonRecord() === undefined) {
      const bootstrapped = await runCliEffect(
        Effect.gen(function* () {
          const lock = yield* cliTryPromise(() =>
            acquireLifecycleLock(daemonLifecycleLockPath(), {
              timeoutMs: 90_000
            })
          );
          return yield* Effect.gen(function* () {
            if (readDaemonRecord() !== undefined) return false;
            if (existsSync(path) && options.force !== true) {
              return yield* new RouteKitFailure({
                message: `${path} already exists (pass --force to replace it)`
              });
            }
            writeRouterConfig(path, starterConfig);
            if (missingCredentials.length === 0) {
              yield* ensureDaemon({
                configPath: path,
                lifecycleLockHeld: true
              });
            }
            return true;
          }).pipe(Effect.ensuring(Effect.sync(() => lock.release())));
        })
      );
      if (bootstrapped) {
        if (ctx.json) {
          ctx.emit({
            path,
            created: true,
            providers,
            ...(starterConfig.defaultModel !== undefined
              ? { defaultModel: starterConfig.defaultModel }
              : {}),
            daemonStarted: missingCredentials.length === 0,
            nextSteps,
            ...(missingCredentials.length > 0
              ? {
                  missingCredentials
                }
              : {})
          });
        } else {
          ctx.presenter.success(`created ${path}`);
          if (providers.length === 0) {
            ctx.presenter.note("created an empty subscription bootstrap");
          } else {
            ctx.presenter.note(`providers: ${providers.join(", ")}`);
            if (starterConfig.defaultModel !== undefined) {
              ctx.presenter.note(`default model: ${starterConfig.defaultModel}`);
            }
          }
          if (missingCredentials.length > 0) {
            ctx.presenter.warn(`daemon not started: set ${missingCredentials.join(" or ")}`);
            ctx.presenter.note("then run `routekit start`");
          }
        }
        return;
      }
    }
    if (existsSync(path) && options.force !== true) {
      throw new Error(`${path} already exists (pass --force to replace it)`);
    }
    await runCliEffect(
      Effect.gen(function* () {
        const connected = yield* connectDaemon;
        const client = connected?.client ?? (yield* routekitClient);
        const current = yield* client.call("config.get", {});
        if (resolve(current.path) !== resolve(path)) {
          return yield* new RouteKitFailure({
            message:
              `RouteKit is running with foreground config ${current.path}; ` +
              "stop it before replacing the canonical singleton config"
          });
        }
        return yield* client.call(
          "config.update",
          {
            expectedRevision: current.revision,
            document: stringifyYaml(starterConfig)
          },
          {
            idempotencyKey: configInitIdempotencyKey({
              revision: current.revision,
              config: starterConfig
            })
          }
        );
      })
    );
    if (ctx.json) {
      ctx.emit({
        path,
        created: true,
        providers,
        ...(starterConfig.defaultModel !== undefined
          ? { defaultModel: starterConfig.defaultModel }
          : {}),
        daemonStarted: true,
        nextSteps
      });
    } else {
      ctx.presenter.success(`created ${path}`);
    }
  });

  config
    .command("edit")
    .description("edit and atomically validate the canonical singleton router config")
    .addOption(new Option("--global").hideHelp())
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command, runtime);
      if (ctx.json) {
        throw new Error("`config edit` is interactive and does not support --json");
      }
      const path = await runCliClient((client) =>
        Effect.gen(function* () {
          const snapshot = yield* client.call("config.get", {});
          const directory = mkdtempSync(join(tmpdir(), "routekit-config-"));
          const temporary = join(directory, "router.yaml");
          return yield* Effect.gen(function* () {
            writeFileSync(temporary, snapshot.document, { mode: 0o600 });
            const editor = runtime.env.EDITOR ?? runtime.env.VISUAL;
            if (editor === undefined || editor.length === 0) {
              return yield* new RouteKitFailure({
                message: "set EDITOR or VISUAL before running config edit"
              });
            }
            const result = yield* cliTry(() =>
              spawnSync(editor, [temporary], { stdio: "inherit" })
            );
            if (result.error !== undefined)
              return yield* toRouteKitFailure(result.error);
            if (result.status !== 0) {
              return yield* new RouteKitFailure({
                message: `${editor} exited with status ${result.status}`
              });
            }
            const editedDocument = readFileSync(temporary, "utf8");
            // Parse client-side for immediate syntax feedback; the daemon performs
            // authoritative schema validation and transactional router reload.
            yield* cliTry(() => parseYaml(editedDocument));
            yield* client.call(
              "config.update",
              { expectedRevision: snapshot.revision, document: editedDocument },
              { idempotencyKey: `config-edit-${snapshot.revision}` }
            );
            return snapshot.path;
          }).pipe(
            Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true })))
          );
        })
      );
      ctx.presenter.success(`updated ${path}`);
    });

  config
    .command("import")
    .description("validate a router file and replace the canonical singleton config")
    .requiredOption("--from <path>", "router YAML to import as the complete canonical config")
    .action(async (options: { from: string }, command: Command) => {
      const ctx = contextFor(command, runtime);
      const result = await runCliEffect(importRouterConfig.execute(options.from));
      if (ctx.json) ctx.emit(result);
      else ctx.presenter.success(`imported ${result.source} into ${result.path}`);
    });
}
