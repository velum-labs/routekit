import {
  CliError,
  type CliRuntime,
  contextForFlags,
  processCliRuntime
} from "@velum-labs/routekit-cli-core";
import { decodeJoinCredential } from "@velum-labs/routekit-runtime/tokens";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { gatewayHealthy } from "../../adapters/gateway-probe.js";
import { remoteControlClient } from "../../adapters/ssh-control.js";
import {
  classifySshFailure,
  redactSensitiveText,
  remoteShellArgv,
  runSshCommand,
  sshExitError
} from "../../adapters/ssh-exec.js";
import { type CliSession, cliTryPromise } from "../../cli-session.js";
import { resolveCredentialArgument } from "../../credentials.js";
import { PEER_ADD_SCRIPT } from "../../generated/shell-scripts.js";
import {
  type ProvisionStepId,
  remoteNameFromSshHost,
  validateInstallVersion
} from "../../remote-provision.js";
import {
  normalizeRemoteUrl,
  type RouteKitRemote,
  validateRemoteName,
  validateSshHost
} from "../../remotes.js";
import { EnrollRemote, ProvisionRemote, RemoveRemote } from "../../services/remote/service.js";
import { routekitVersion } from "../../state.js";
import { routekitRoot } from "../root-command.js";

const optionalStringFlag = (name: string) =>
  Flag.string(name).pipe(Flag.optional, Flag.map(Option.getOrUndefined));
const optionalStringArgument = (name: string) =>
  Argument.string(name).pipe(Argument.optional, Argument.map(Option.getOrUndefined));

async function enrollPeerOverSsh(input: {
  sshHost: string;
  joinCredential: string;
}): Promise<{ publicRecordPath: string }> {
  const decoded = decodeJoinCredential(input.joinCredential);
  const secrets = [input.joinCredential, decoded.token];
  let result;
  try {
    result = await runSshCommand(input.sshHost, remoteShellArgv(PEER_ADD_SCRIPT), {
      timeoutMs: 30_000,
      stdin: `${input.joinCredential}\n`
    });
  } catch (error) {
    const failure = classifySshFailure(error, secrets);
    if (failure.missingSshClient) {
      throw new Error("ssh was not found on PATH; install an SSH client before adding a remote");
    }
    throw new CliError({
      message:
        `peer enrollment over SSH to ${input.sshHost} failed` +
        (failure.detail.length > 0 ? `: ${failure.detail}` : ""),
      hint:
        failure.code === "not_found"
          ? "upgrade the remote CLI so it supports `routekit peer add -`, then retry"
          : undefined
    });
  }
  if (result.exitCode !== 0) {
    const failure = classifySshFailure(sshExitError(result, input.sshHost), secrets);
    const detail = peerAddFailureDetail(result.stdout, result.stderr, secrets);
    throw new CliError({
      message:
        `peer enrollment over SSH to ${input.sshHost} failed` +
        (detail.length > 0 ? `: ${detail}` : ""),
      hint:
        failure.code === "not_found"
          ? "upgrade the remote CLI so it supports `routekit peer add -`, then retry"
          : "ask the owner for a fresh join credential (`routekit token issue <label> --plane control`)"
    });
  }
  return { publicRecordPath: decoded.publicRecordPath };
}

function peerAddFailureDetail(stdout: string, stderr: string, secrets: Iterable<string>): string {
  const trimmedOut = stdout.trim();
  if (trimmedOut.length > 0) {
    try {
      const parsed = JSON.parse(trimmedOut) as { error?: { message?: unknown }; peer?: unknown };
      if (typeof parsed.error?.message === "string" && parsed.error.message.length > 0) {
        return redactSensitiveText(parsed.error.message, secrets);
      }
    } catch {
      // Not JSON; fall through to stderr.
    }
  }
  const meaningful = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/^Warning: Permanently added/i.test(line) &&
        !/^bash: warning: setlocale/i.test(line)
    );
  return redactSensitiveText(meaningful.join("\n"), secrets);
}

function remoteDetails(session: CliSession, remote: RouteKitRemote) {
  return Effect.all(
    [
      cliTryPromise(() => session.remotes.credentials.read(remote.name)),
      gatewayHealthy(remote.gatewayUrl),
      remoteControlClient(remote).hello().pipe(Effect.orElseSucceed(() => undefined))
    ],
    { concurrency: "unbounded" }
  ).pipe(
    Effect.map(([token, healthy, hello]) => ({
      ...remote,
      active: session.remotes.registry.active()?.name === remote.name,
      token: token === undefined ? ("missing" as const) : ("stored" as const),
      healthy,
      ...(hello?.packageVersion !== undefined ? { remoteVersion: hello.packageVersion } : {}),
      ...(hello?.protocolVersion !== undefined ? { protocol: hello.protocolVersion } : {})
    }))
  );
}

export type EnrolledPeer = { publicRecordPath: string };

const INSTALL_STEP_LABELS: Record<ProvisionStepId, string> = {
  probe: "probe host",
  install: "install RouteKit",
  config: "create router config",
  start: "start daemon"
};

const makeInstallCommand = (
  session: CliSession,
  runtime: CliRuntime
): Command.Command.Any => {
  const provisionRemote = new ProvisionRemote(new EnrollRemote(session.remotes, runtime));
  return Command.make(
    "install",
    {
      sshHost: Argument.string("ssh-host"),
      name: optionalStringFlag("name").pipe(
        Flag.withDescription("remote name to enroll as (default: the host name)")
      ),
      url: optionalStringFlag("url").pipe(
        Flag.withDescription("public gateway URL to enroll once the host is running")
      ),
      version: optionalStringFlag("version").pipe(
        Flag.withDescription("RouteKit version to install (default: this CLI's version)")
      ),
      force: Flag.boolean("force").pipe(
        Flag.withDescription("reinstall even when the host already runs the target version")
      ),
      dryRun: Flag.boolean("dry-run").pipe(
        Flag.withDescription("probe the host and report the steps without changing it")
      ),
      use: Flag.boolean("use").pipe(
        Flag.withDefault(true),
        Flag.withDescription("make this the active remote after enrollment")
      )
    },
    (options) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const sshHost = options.sshHost;
        validateSshHost(sshHost);
        const version = validateInstallVersion(options.version ?? routekitVersion());
        const gatewayUrl = options.url === undefined ? undefined : normalizeRemoteUrl(options.url);
        let name: string | undefined;
        if (gatewayUrl !== undefined) {
          name = options.name ?? remoteNameFromSshHost(sshHost);
          if (name === undefined) {
            return yield* Effect.fail(
              new CliError({
                message: `cannot derive a remote name from ${JSON.stringify(sshHost)}`,
                hint: "pass --name <name>"
              })
            );
          }
          validateRemoteName(name);
        } else if (options.name !== undefined) {
          return yield* Effect.fail(
            new CliError({
              message: "--name only applies when --url enrolls the host",
              hint: `provide --url <https-url>, or enroll later with \`routekit remote add ${options.name} --url <https-url> --ssh ${sshHost}\``
            })
          );
        }
        const checklist = ctx.presenter.checklist(
          [
            ...(Object.keys(INSTALL_STEP_LABELS) as ProvisionStepId[]).map((id) => ({
              id,
              label: INSTALL_STEP_LABELS[id]
            })),
            ...(gatewayUrl !== undefined ? [{ id: "enroll", label: "enroll gateway" }] : [])
          ],
          { title: `RouteKit ${options.dryRun ? "plan for" : "install on"} ${sshHost}` }
        );
        const execution = yield* provisionRemote
          .execute({
            sshHost,
            version,
            force: options.force,
            dryRun: options.dryRun,
            ...(gatewayUrl !== undefined && name !== undefined
              ? { enrollment: { name, gatewayUrl, use: options.use } }
              : {}),
            onStepStart: (id) => checklist.setActive(id),
            onStep: (step) => {
              if (step.status === "done") checklist.setDone(step.id, step.detail);
              else checklist.setSkipped(step.id, step.detail);
            }
          })
          .pipe(Effect.ensuring(Effect.sync(() => checklist.stop())));
        const { provisioned, enrolled } = execution;
        if (enrolled !== undefined && gatewayUrl !== undefined && name !== undefined) {
          checklist.setActive("enroll");
          checklist.setDone("enroll", `${name} at ${gatewayUrl}`);
        } else if (gatewayUrl !== undefined) {
          checklist.setSkipped("enroll", options.dryRun ? "dry run" : "the remote daemon is not running");
        }
        const result = {
          host: sshHost,
          version,
          targetVersion: provisioned.targetVersion,
          dryRun: options.dryRun,
          probe: provisioned.probe,
          steps: provisioned.steps,
          ...(provisioned.installedVersion !== undefined
            ? { installedVersion: provisioned.installedVersion }
            : {}),
          ...(provisioned.gateway !== undefined ? { gateway: provisioned.gateway } : {}),
          ...(provisioned.blocked !== undefined ? { blocked: provisioned.blocked } : {}),
          ...(enrolled !== undefined ? { remote: enrolled.remote } : {})
        };
        if (ctx.json) {
          ctx.emit(result);
          return;
        }
        if (options.dryRun) {
          ctx.presenter.note(`no changes were made to ${sshHost}`);
          return;
        }
        if (provisioned.blocked !== undefined) {
          ctx.presenter.warn(`RouteKit is installed on ${sshHost} but not running: ${provisioned.blocked}`);
          ctx.presenter.note(
            "add a provider credential on the host (an API key, or " +
              `\`ssh ${sshHost} routekit accounts login codex\`), then ` +
              `\`ssh ${sshHost} routekit start\``
          );
          return;
        }
        ctx.presenter.success(
          `RouteKit ${provisioned.installedVersion ?? provisioned.targetVersion} is running on ${sshHost}`
        );
        if (provisioned.gateway !== undefined) ctx.presenter.line(`  gateway: ${provisioned.gateway.url}`);
        if (enrolled !== undefined) {
          ctx.presenter.line(`  remote: ${enrolled.remote.name} -> ${enrolled.remote.gatewayUrl}`);
          if (enrolled.versionMismatch !== undefined) {
            ctx.presenter.warn(
              `client v${routekitVersion()} differs from remote v${enrolled.versionMismatch}; compatible control protocol accepted`
            );
          }
          if (enrolled.remote.active) ctx.presenter.note(`${enrolled.remote.name} is now the active remote`);
        } else {
          ctx.presenter.note(
            "expose the gateway over HTTPS, then run " +
              `\`routekit remote add ${remoteNameFromSshHost(sshHost) ?? "<name>"} --url <https-url> --ssh ${sshHost}\``
          );
        }
      })
  ).pipe(Command.withDescription("install and start RouteKit on an SSH host, then optionally enroll it"));
};

export const makeRemoteCommand = (
  session: CliSession,
  runtime: CliRuntime = processCliRuntime
): Command.Command.Any => {
  const enrollRemote = new EnrollRemote(session.remotes, runtime);
  const removeRemote = new RemoveRemote(session.remotes);
  const add = Command.make(
    "add",
    {
      name: Argument.string("name"),
      url: Flag.string("url").pipe(Flag.withDescription("public RouteKit gateway URL")),
      ssh: Flag.string("ssh").pipe(Flag.withDescription("SSH host used for remote administration")),
      join: optionalStringFlag("join").pipe(
        Flag.withDescription("enroll the SSH account as a peer first (pass - to read from stdin)")
      ),
      use: Flag.boolean("use").pipe(
        Flag.withDefault(true),
        Flag.withDescription("make this the active remote")
      )
    },
    (options) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        validateRemoteName(options.name);
        const gatewayUrl = normalizeRemoteUrl(options.url);
        validateSshHost(options.ssh);
        let peer: EnrolledPeer | undefined;
        if (options.join !== undefined) {
          const joinCredential = yield* cliTryPromise(() => resolveCredentialArgument(options.join!));
          peer = yield* cliTryPromise(() =>
            enrollPeerOverSsh({ sshHost: options.ssh, joinCredential })
          );
        }
        const enrolled = yield* enrollRemote.execute({
          name: options.name,
          gatewayUrl,
          sshHost: options.ssh,
          use: options.use
        });
        if (ctx.json) {
          ctx.emit({ remote: enrolled.remote, ...(peer !== undefined ? { peer } : {}) });
          return;
        }
        ctx.presenter.success(`added RouteKit remote ${options.name}`);
        ctx.presenter.line(`  gateway: ${gatewayUrl}`);
        ctx.presenter.line(`  control: ssh ${options.ssh}`);
        if (peer !== undefined) ctx.presenter.line(`  peer: ${peer.publicRecordPath}`);
        if (enrolled.versionMismatch !== undefined) {
          ctx.presenter.warn(
            `client v${routekitVersion()} differs from remote v${enrolled.versionMismatch}; compatible control protocol accepted`
          );
        }
        if (enrolled.remote.active) ctx.presenter.note(`${options.name} is now the active remote`);
      })
  ).pipe(Command.withDescription("add a remote gateway and obtain its token over SSH"));

  const list = Command.make("list", {}, () =>
    Effect.gen(function* () {
      const ctx = contextForFlags(yield* routekitRoot, runtime);
      const registry = session.remotes.registry.read();
      const rows = yield* Effect.forEach(
        registry.remotes,
        (entry) =>
          cliTryPromise(() => session.remotes.credentials.read(entry.name)).pipe(
            Effect.map((token) => ({
              ...entry,
              active: registry.active === entry.name,
              token: token === undefined ? "missing" : "stored"
            }))
          ),
        { concurrency: "unbounded" }
      );
      if (ctx.json) ctx.emit({ active: registry.active, remotes: rows });
      else if (rows.length === 0) ctx.presenter.note("no RouteKit remotes configured");
      else {
        ctx.presenter.table(
          rows.map((entry) => [
            entry.active ? `* ${entry.name}` : entry.name,
            entry.gatewayUrl,
            entry.sshHost,
            entry.token
          ]),
          { head: ["Remote", "Gateway", "SSH", "Token"] }
        );
      }
    })
  ).pipe(Command.withDescription("list configured remote gateways"));

  const show = Command.make(
    "show",
    { name: optionalStringArgument("name") },
    ({ name }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const selected =
          name === undefined ? session.remotes.registry.active() : session.remotes.registry.find(name);
        if (selected === undefined) {
          return yield* Effect.fail(
            new Error(name === undefined ? "no active RouteKit remote" : `unknown RouteKit remote: ${name}`)
          );
        }
        const result = yield* remoteDetails(session, selected);
        if (ctx.json) ctx.emit(result);
        else {
          ctx.presenter.keyValue([
            { label: "Name", value: result.name + (result.active ? " (active)" : "") },
            { label: "Gateway", value: result.gatewayUrl },
            { label: "SSH", value: result.sshHost },
            { label: "Health", value: result.healthy ? "reachable" : "unreachable" },
            { label: "Token", value: result.token },
            { label: "Version", value: result.remoteVersion ?? "unavailable" },
            { label: "Protocol", value: result.protocol ?? "unavailable" }
          ]);
        }
      })
  ).pipe(Command.withDescription("show and probe one remote gateway"));

  const use = Command.make(
    "use",
    {
      name: optionalStringArgument("name"),
      none: Flag.boolean("none").pipe(
        Flag.withDescription("clear the active remote and use the local daemon")
      )
    },
    ({ name, none }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        if (none && name !== undefined) {
          return yield* Effect.fail(new Error("provide a remote name or --none, not both"));
        }
        if (!none && name === undefined) {
          return yield* Effect.fail(new Error("provide a remote name or --none"));
        }
        session.remotes.registry.use(none ? undefined : name);
        const result = { active: none ? null : name };
        if (ctx.json) ctx.emit(result);
        else if (none) ctx.presenter.success("RouteKit now targets the local daemon");
        else ctx.presenter.success(`RouteKit now targets remote ${name}`);
      })
  ).pipe(Command.withDescription("select the active remote, or return to local mode"));

  const remove = Command.make(
    "remove",
    { name: Argument.string("name") },
    ({ name }) =>
      Effect.gen(function* () {
        const ctx = contextForFlags(yield* routekitRoot, runtime);
        const result = yield* removeRemote.execute(name);
        if (ctx.json) ctx.emit(result);
        else ctx.presenter.success(`removed RouteKit remote ${name}`);
      })
  ).pipe(Command.withDescription("remove a remote gateway and its stored token"));

  return Command.make("remote").pipe(
    Command.withDescription("manage shared RouteKit gateways"),
    Command.withSubcommands([makeInstallCommand(session, runtime), add, list, show, use, remove])
  );
};
