import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { contextFor } from "@velum-labs/routekit-cli-core";
import {
  parseRouterConfig,
  splitNamespacedModel,
  type RouterConfig
} from "@velum-labs/routekit-gateway";
import { catalogDefaultModel } from "@velum-labs/routekit-registry";
import { acquireLifecycleLock } from "@velum-labs/routekit-runtime";
import { Option, type Command } from "commander";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  DEFAULT_ROUTER_CONFIG,
  globalRouterConfigPath,
  writeRouterConfig
} from "../config.js";
import {
  connectDaemon,
  daemonLifecycleLockPath,
  ensureDaemon,
  readDaemonRecord,
  routekitClient
} from "../client.js";
import { missingServiceCredentialVariables } from "../daemon.js";
import { selectedRemoteMetadata } from "../target.js";

import { configOverride } from "./context.js";

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

export function configImportIdempotencyKey(input: {
  revision: number;
  document: string;
  source: string;
}): string {
  const fingerprint = createHash("sha256")
    .update(String(input.revision))
    .update("\0")
    .update(input.source)
    .update("\0")
    .update(input.document)
    .digest("hex")
    .slice(0, 24);
  return `config-import-${input.revision}-${fingerprint}`;
}

export function registerConfig(program: Command): void {
  const config = program.command("config").description("manage router configuration");

  config
    .command("path")
    .description("print the canonical singleton router config path")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      if (configOverride(command) !== undefined) {
        throw new Error(
          "--config is not supported by daemon-backed commands; use `routekit config import --from <path>`"
        );
      }
      const path = (await (await routekitClient()).call("config.get", {})).path;
      if (ctx.json) ctx.emit({ path, exists: existsSync(path) });
      else process.stdout.write(`${path}\n`);
    });

  config
    .command("show")
    .description("show the validated canonical singleton router config")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const result = await (await routekitClient()).call("config.get", {});
      if (ctx.json) {
        ctx.emit({
          path: result.path,
          revision: result.revision,
          sources: result.sources,
          config: parseYaml(result.document)
        });
      } else process.stdout.write(result.document);
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
    const ctx = contextFor(command);
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
      const lock = await acquireLifecycleLock(daemonLifecycleLockPath(), {
        timeoutMs: 90_000
      });
      let bootstrapped = false;
      try {
        if (readDaemonRecord() === undefined) {
          if (existsSync(path) && options.force !== true) {
            throw new Error(`${path} already exists (pass --force to replace it)`);
          }
          writeRouterConfig(path, starterConfig);
          if (missingCredentials.length === 0) {
            await ensureDaemon({
              configPath: path,
              lifecycleLockHeld: true
            });
          }
          bootstrapped = true;
        }
      } finally {
        lock.release();
      }
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
    const client = (await connectDaemon())?.client ?? (await routekitClient());
    const current = await client.call("config.get", {});
    if (resolve(current.path) !== resolve(path)) {
      throw new Error(
        `RouteKit is running with foreground config ${current.path}; ` +
          "stop it before replacing the canonical singleton config"
      );
    }
    await client.call(
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
      const ctx = contextFor(command);
      if (ctx.json) {
        throw new Error("`config edit` is interactive and does not support --json");
      }
      const client = await routekitClient();
      const snapshot = await client.call("config.get", {});
      const path = snapshot.path;
      const directory = mkdtempSync(join(tmpdir(), "routekit-config-"));
      const temporary = join(directory, "router.yaml");
      try {
        writeFileSync(temporary, snapshot.document, { mode: 0o600 });
        const editor = process.env.EDITOR ?? process.env.VISUAL;
        if (editor === undefined || editor.length === 0) {
          throw new Error("set EDITOR or VISUAL before running config edit");
        }
        const result = spawnSync(editor, [temporary], { stdio: "inherit" });
        if (result.error !== undefined) throw result.error;
        if (result.status !== 0) throw new Error(`${editor} exited with status ${result.status}`);
        const editedDocument = readFileSync(temporary, "utf8");
        // Parse client-side for immediate syntax feedback; the daemon performs
        // authoritative schema validation and transactional router reload.
        parseYaml(editedDocument);
        await client.call(
          "config.update",
          { expectedRevision: snapshot.revision, document: editedDocument },
          { idempotencyKey: `config-edit-${snapshot.revision}` }
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      ctx.presenter.success(`updated ${path}`);
    });

  config
    .command("import")
    .description("validate a router file and replace the canonical singleton config")
    .requiredOption("--from <path>", "router YAML to import as the complete canonical config")
    .action(async (options: { from: string }, command: Command) => {
      const ctx = contextFor(command);
      const source = resolve(options.from);
      if (!existsSync(source)) throw new Error(`router config not found: ${source}`);
      const document = readFileSync(source, "utf8");
      parseYaml(document);
      const canonical = globalRouterConfigPath();
      const remote = selectedRemoteMetadata();
      let revision: number | undefined;
      let destination = canonical;
      const replaceThroughDaemon = async (): Promise<{ revision: number; path: string }> => {
        const client =
          remote !== undefined
            ? await routekitClient()
            : ((await connectDaemon())?.client ?? (await routekitClient()));
        const current = await client.call("config.get", {});
        if (remote === undefined && resolve(current.path) !== resolve(canonical)) {
          throw new Error(
            `RouteKit is running with foreground config ${current.path}; ` +
              "stop it before importing into the canonical singleton config"
          );
        }
        const imported = await client.call(
          "config.import",
          {
            expectedRevision: current.revision,
            document,
            source
          },
          {
            idempotencyKey: configImportIdempotencyKey({
              revision: current.revision,
              document,
              source
            })
          }
        );
        return { revision: imported.revision, path: current.path };
      };
      if (remote === undefined && readDaemonRecord() === undefined) {
        const lock = await acquireLifecycleLock(daemonLifecycleLockPath(), {
          timeoutMs: 90_000
        });
        try {
          if (readDaemonRecord() === undefined) {
            // Bootstrap/recovery exception. The lifecycle lock makes the
            // direct write and daemon start one authority transition.
            writeRouterConfig(canonical, parseYaml(document));
            const started = await ensureDaemon({
              configPath: canonical,
              lifecycleLockHeld: true
            });
            revision = (await started.client.call("config.get", {})).revision;
          }
        } finally {
          lock.release();
        }
      }
      if (revision === undefined) {
        const replaced = await replaceThroughDaemon();
        revision = replaced.revision;
        destination = replaced.path;
      }
      if (ctx.json) ctx.emit({ imported: true, source, path: destination, revision });
      else ctx.presenter.success(`imported ${source} into ${destination}`);
    });

}
