import {
  type CliRuntime,
  contextForFlags,
  immutableCliRuntime,
  processCliRuntime,
  readPackageVersion
} from "@velum-labs/routekit-cli-core";
import { configuredProviderIds } from "@velum-labs/routekit-config";
import { resolveAccountConnector } from "@velum-labs/routekit-registry";
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";

import { listAccounts } from "../accounts.js";
import type { CliSession } from "../cli-session.js";
import { globalRouterConfigPath, loadRouterConfig } from "../config.js";
import {
  isLaunchAccountKind,
  isLaunchToolId,
  LAUNCH_ACCOUNT_KIND_CHOICES,
  LAUNCH_PROVIDER_IDS
} from "../launch-support.js";
import { readStateSnapshot } from "../state.js";
import { makeAccountsCommand } from "./commands/accounts.js";
import { makeCallsCommand } from "./commands/calls.js";
import { makeConfigCommand } from "./commands/config.js";
import { makeCredentialShellCommand, makeCredentialsCommand } from "./commands/credentials.js";
import { makeDaemonCommand } from "./commands/daemon.js";
import { makeDoctorCommand } from "./commands/doctor.js";
import { makeEvalCommand } from "./commands/eval.js";
import { makeLauncherCommands } from "./commands/launchers.js";
import { makeLeaderboardCommand } from "./commands/leaderboard.js";
import { makeModelsCommand } from "./commands/models.js";
import { makePeerCommand } from "./commands/peer.js";
import { makePolicyCommand } from "./commands/policy.js";
import { makeProvidersCommand } from "./commands/providers.js";
import { makeRemoteCommand } from "./commands/remote.js";
import { makeSelfInspectCommand } from "./commands/self-inspect.js";
import { makeSelfUpdateCommand } from "./commands/self-update.js";
import { makeSetupCommand } from "./commands/setup.js";
import { makeStartCommand } from "./commands/start.js";
import { makeStatusCommand } from "./commands/status.js";
import { makeStopCommand } from "./commands/stop.js";
import { makeTelemetryCommand } from "./commands/telemetry.js";
import { makeTokensCommand } from "./commands/tokens.js";
import { makeUsageCommand } from "./commands/usage.js";
import {
  COMPLETION_SHELLS,
  completionCandidates,
  completionScript,
  isCompletionShell
} from "./completion.js";
import { routekitRoot } from "./root-command.js";

export function routekitVersion(): string {
  return readPackageVersion(import.meta.url);
}

function providerIds(): string[] {
  try {
    return configuredProviderIds(loadRouterConfig({ configPath: globalRouterConfigPath() }).config);
  } catch {
    return [];
  }
}

function modelIds(): string[] {
  const snapshot = readStateSnapshot("catalog", "models");
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return [];
  const models = (snapshot as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    if (typeof model === "string") return [model];
    if (
      typeof model === "object" &&
      model !== null &&
      !Array.isArray(model) &&
      typeof (model as { id?: unknown }).id === "string"
    ) {
      return [(model as { id: string }).id];
    }
    return [];
  });
}

function dynamicValues(
  path: readonly string[],
  argumentDepth: number,
  positional: readonly string[]
): string[] {
  const [group, subcommand] = path;
  if (group === "providers" && (subcommand === "remove" || subcommand === "status") && argumentDepth === 0) {
    return providerIds();
  }
  if (group === "providers" && subcommand === "add" && argumentDepth === 0) {
    const configured = new Set(providerIds());
    return LAUNCH_PROVIDER_IDS.filter((provider) => !configured.has(provider));
  }
  if (group !== undefined && isLaunchToolId(group) && argumentDepth === 0) return modelIds();
  if (group === "accounts" && subcommand === "add" && argumentDepth === 0) {
    return [...LAUNCH_ACCOUNT_KIND_CHOICES];
  }
  if (group === "accounts" && (subcommand === "login" || subcommand === "rename") && argumentDepth === 0) {
    return [...LAUNCH_ACCOUNT_KIND_CHOICES];
  }
  if (group === "accounts" && subcommand === "remove" && argumentDepth === 0) {
    return [
      ...new Set([
        ...LAUNCH_ACCOUNT_KIND_CHOICES,
        ...listAccounts()
          .map((entry) => entry.subscriptionKind)
          .filter((kind) => {
            const resolved = resolveAccountConnector(kind);
            return isLaunchAccountKind(resolved?.kind ?? kind);
          })
      ])
    ];
  }
  if (group === "accounts" && subcommand === "remove" && argumentDepth === 1) {
    const suppliedKind = positional[0] ?? "";
    const resolved = resolveAccountConnector(suppliedKind);
    const kind = resolved?.kind ?? suppliedKind;
    if (!isLaunchAccountKind(kind)) return [];
    return listAccounts()
      .filter((entry) =>
        entry.subscriptionKind === kind ||
        (resolved !== undefined && resolveAccountConnector(entry.subscriptionKind)?.kind === resolved.kind)
      )
      .map((entry) => entry.label);
  }
  if (group === "accounts" && subcommand === "rename" && argumentDepth === 1) {
    const suppliedKind = positional[0] ?? "";
    const resolved = resolveAccountConnector(suppliedKind);
    if (resolved?.info.connector !== "native" || !isLaunchAccountKind(resolved.kind)) return [];
    return listAccounts()
      .filter((entry) => entry.connector === "native" && entry.subscriptionKind === resolved.kind)
      .map((entry) => entry.label);
  }
  if (group === "completion" && argumentDepth === 0) return [...COMPLETION_SHELLS];
  return [];
}

export function buildEffectProgram(
  session: CliSession,
  runtimeInput: CliRuntime = processCliRuntime
): Command.Command.Any {
  const runtime = immutableCliRuntime(runtimeInput);
  const version = routekitVersion();
  const versionCommand = Command.make("version", {}, () =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      if (ctx.json) ctx.emit({ package: "@velum-labs/routekit", version });
      else runtime.stdout.write(`@velum-labs/routekit ${version}\n`);
    })
  ).pipe(Command.withDescription("show the RouteKit CLI version"));

  let program: Command.Command.Any;
  const completion = Command.make(
    "completion",
    { shell: Argument.string("shell") },
    ({ shell }) =>
      Effect.sync(() => {
        if (!isCompletionShell(shell)) {
          throw new Error(`unsupported shell "${shell}" (expected ${COMPLETION_SHELLS.join(" | ")})`);
        }
        runtime.stdout.write(completionScript(shell, "routekit", program));
      })
  ).pipe(Command.withDescription("advanced: print a shell completion script"));
  const complete = Command.make(
    "__complete",
    { words: Argument.string("words").pipe(Argument.variadic({ min: 0 })) },
    ({ words }) =>
      Effect.sync(() => {
        runtime.stdout.write(
          completionCandidates(program, words, dynamicValues)
            .map((candidate) => `${candidate}\n`)
            .join("")
        );
      })
  ).pipe(Command.withDescription("internal completion protocol"), Command.unlisted);

  program = routekitRoot.pipe(
    Command.withSubcommands([
      makeSetupCommand(runtime),
      makeRemoteCommand(session, runtime),
      makePeerCommand(runtime),
      makeTokensCommand(runtime),
      makeCredentialShellCommand(runtime),
      makeCredentialsCommand(runtime),
      makeAccountsCommand(runtime),
      makeProvidersCommand(runtime),
      makeConfigCommand(runtime),
      makeStartCommand(runtime),
      makeStopCommand(runtime),
      makeDaemonCommand(runtime),
      ...makeLauncherCommands(runtime),
      makeStatusCommand(runtime),
      makeUsageCommand(runtime),
      makeLeaderboardCommand(runtime),
      makeCallsCommand(runtime),
      makeModelsCommand(runtime),
      makeDoctorCommand(runtime),
      makeEvalCommand(runtime),
      makePolicyCommand(runtime),
      makeSelfUpdateCommand(runtime),
      makeSelfInspectCommand(runtime),
      makeTelemetryCommand(runtime),
      completion,
      complete,
      versionCommand
    ])
  );
  return program;
}
