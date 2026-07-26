import { CliError, contextFor } from "@velum-labs/routekit-cli-core";
import { ROUTEKIT_CONTROL_CAPABILITY } from "@velum-labs/routekit-control";
import type { Command } from "commander";

import {
  provisionRemoteHost,
  remoteNameFromSshHost,
  validateInstallVersion,
  type ProvisionStepId
} from "../remote-provision.js";
import {
  activeRemote,
  deleteRemoteToken,
  findRemote,
  normalizeRemoteUrl,
  putRemote,
  readRemoteRegistry,
  readRemoteToken,
  removeRemote,
  useRemote,
  validateRemoteName,
  validateSshHost,
  writeRemoteToken,
  type RouteKitRemote
} from "../remotes.js";
import { remoteControlClient } from "../ssh-control.js";
import {
  classifySshFailure,
  REMOTE_PATH_PREAMBLE,
  remoteShellArgv,
  runSshCommand,
  sshExitError
} from "../ssh-exec.js";
import { routekitVersion } from "../state.js";

const TOKEN_SCRIPT = [
  REMOTE_PATH_PREAMBLE,
  "exec routekit --local daemon auth show --json"
].join("\n");

async function bootstrapToken(sshHost: string): Promise<string> {
  let stdout: string;
  try {
    const result = await runSshCommand(sshHost, remoteShellArgv(TOKEN_SCRIPT), {
      timeoutMs: 30_000
    });
    if (result.exitCode !== 0) throw sshExitError(result, sshHost);
    stdout = result.stdout;
  } catch (error) {
    const failure = classifySshFailure(error);
    if (failure.missingSshClient) {
      throw new Error("ssh was not found on PATH; install an SSH client before adding a remote");
    }
    throw new Error(
      "could not obtain the remote gateway token over SSH" +
        (failure.detail.length > 0 ? `: ${failure.detail}` : "")
    );
  }
  let parsed: { token?: unknown };
  try {
    parsed = JSON.parse(stdout) as { token?: unknown };
  } catch {
    throw new Error("remote RouteKit returned invalid JSON while obtaining the gateway token");
  }
  if (typeof parsed.token !== "string" || parsed.token.length === 0) {
    throw new Error("remote RouteKit returned no gateway token");
  }
  return parsed.token;
}

async function gatewayHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function details(remote: RouteKitRemote): Promise<{
  name: string;
  gatewayUrl: string;
  sshHost: string;
  addedAt: string;
  active: boolean;
  token: "stored" | "missing";
  healthy: boolean;
  remoteVersion?: string;
  protocol?: string;
}> {
  const [token, healthy, hello] = await Promise.all([
    readRemoteToken(remote.name),
    gatewayHealthy(remote.gatewayUrl),
    remoteControlClient(remote).hello().catch(() => undefined)
  ]);
  return {
    ...remote,
    active: activeRemote()?.name === remote.name,
    token: token === undefined ? "missing" : "stored",
    healthy,
    ...(hello?.packageVersion !== undefined ? { remoteVersion: hello.packageVersion } : {}),
    ...(hello?.protocolVersion !== undefined ? { protocol: hello.protocolVersion } : {})
  };
}

export type EnrolledRemote = RouteKitRemote & {
  active: boolean;
  token: "stored";
  healthy: true;
  remoteVersion?: string;
  protocol?: string;
};

/**
 * Obtain the data-plane token over SSH and record the remote once both the
 * HTTPS data plane and the SSH control plane have answered. A failed check
 * leaves the credential store exactly as it was.
 */
async function enrollRemote(input: {
  name: string;
  gatewayUrl: string;
  sshHost: string;
  use: boolean;
}): Promise<{ remote: EnrolledRemote; versionMismatch?: string }> {
  const candidate: RouteKitRemote = {
    name: input.name,
    gatewayUrl: input.gatewayUrl,
    sshHost: input.sshHost,
    addedAt: new Date().toISOString()
  };
  const previous = findRemote(input.name);
  const previousToken = previous === undefined
    ? undefined
    : await readRemoteToken(input.name);
  const token = await bootstrapToken(candidate.sshHost);
  await writeRemoteToken(input.name, token);
  try {
    const [healthy, hello] = await Promise.all([
      gatewayHealthy(candidate.gatewayUrl),
      remoteControlClient(candidate).hello()
    ]);
    if (!healthy) {
      throw new Error(`remote gateway health check failed: ${candidate.gatewayUrl}/health`);
    }
    if (hello.product !== undefined && hello.product !== "routekit") {
      throw new Error(`SSH target is not a RouteKit daemon (reported ${hello.product})`);
    }
    if (!hello.capabilities.includes(ROUTEKIT_CONTROL_CAPABILITY)) {
      throw new Error(
        `remote RouteKit does not advertise ${ROUTEKIT_CONTROL_CAPABILITY}; ` +
          "upgrade the remote CLI"
      );
    }
    putRemote(candidate, input.use);
    return {
      remote: {
        ...candidate,
        active: activeRemote()?.name === input.name,
        token: "stored",
        healthy: true,
        ...(hello.packageVersion !== undefined
          ? { remoteVersion: hello.packageVersion }
          : {}),
        ...(hello.protocolVersion !== undefined ? { protocol: hello.protocolVersion } : {})
      },
      ...(hello.packageVersion !== undefined && hello.packageVersion !== routekitVersion()
        ? { versionMismatch: hello.packageVersion }
        : {})
    };
  } catch (error) {
    if (previousToken === undefined) await deleteRemoteToken(input.name);
    else await writeRemoteToken(input.name, previousToken);
    throw error;
  }
}

const INSTALL_STEP_LABELS: Record<ProvisionStepId, string> = {
  probe: "probe host",
  install: "install RouteKit",
  config: "create router config",
  start: "start daemon"
};

function registerRemoteInstall(remote: Command): void {
  remote
    .command("install <ssh-host>")
    .description("install and start RouteKit on an SSH host, then optionally enroll it")
    .option("--name <name>", "remote name to enroll as (default: the host name)")
    .option("--url <https-url>", "public gateway URL to enroll once the host is running")
    .option("--version <version>", "RouteKit version to install (default: this CLI's version)")
    .option("--force", "reinstall even when the host already runs the target version")
    .option("--dry-run", "probe the host and report the steps without changing it")
    .option("--no-use", "enroll without making this the active remote")
    .action(
      async (
        sshHost: string,
        options: {
          name?: string;
          url?: string;
          version?: string;
          force?: boolean;
          dryRun?: boolean;
          use: boolean;
        },
        command: Command
      ) => {
        const ctx = contextFor(command);
        validateSshHost(sshHost);
        const version = validateInstallVersion(options.version ?? routekitVersion());

        // Resolve everything enrollment needs before touching the host, so a
        // bad URL or an underivable name never leaves a half-provisioned box.
        const gatewayUrl =
          options.url === undefined ? undefined : normalizeRemoteUrl(options.url);
        let name: string | undefined;
        if (gatewayUrl !== undefined) {
          name = options.name ?? remoteNameFromSshHost(sshHost);
          if (name === undefined) {
            throw new CliError({
              message: `cannot derive a remote name from ${JSON.stringify(sshHost)}`,
              hint: "pass --name <name>"
            });
          }
          validateRemoteName(name);
        } else if (options.name !== undefined) {
          throw new CliError({
            message: "--name only applies when --url enrolls the host",
            hint: `provide --url <https-url>, or enroll later with \`routekit remote add ${options.name} --url <https-url> --ssh ${sshHost}\``
          });
        }

        const checklist = ctx.presenter.checklist(
          [
            ...(Object.keys(INSTALL_STEP_LABELS) as ProvisionStepId[]).map((id) => ({
              id,
              label: INSTALL_STEP_LABELS[id]
            })),
            ...(gatewayUrl !== undefined ? [{ id: "enroll", label: "enroll gateway" }] : [])
          ],
          { title: `RouteKit ${options.dryRun === true ? "plan for" : "install on"} ${sshHost}` }
        );
        let provisioned;
        let enrolled;
        try {
          provisioned = await provisionRemoteHost({
            host: sshHost,
            version,
            ...(options.force === true ? { force: true } : {}),
            ...(options.dryRun === true ? { dryRun: true } : {}),
            onStepStart: (id) => checklist.setActive(id),
            onStep: (step) => {
              if (step.status === "done") checklist.setDone(step.id, step.detail);
              else checklist.setSkipped(step.id, step.detail);
            }
          });
          if (
            gatewayUrl !== undefined &&
            name !== undefined &&
            options.dryRun !== true &&
            provisioned.gateway !== undefined
          ) {
            checklist.setActive("enroll");
            enrolled = await enrollRemote({
              name,
              gatewayUrl,
              sshHost,
              use: options.use
            });
            checklist.setDone("enroll", `${name} at ${gatewayUrl}`);
          } else if (gatewayUrl !== undefined) {
            checklist.setSkipped(
              "enroll",
              options.dryRun === true ? "dry run" : "the remote daemon is not running"
            );
          }
        } finally {
          checklist.stop();
        }

        const result = {
          host: sshHost,
          version,
          dryRun: options.dryRun === true,
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

        if (options.dryRun === true) {
          ctx.presenter.note(`no changes were made to ${sshHost}`);
          return;
        }
        if (provisioned.blocked !== undefined) {
          // Carried on the warning itself so `--quiet` still reports the cause.
          ctx.presenter.warn(
            `RouteKit is installed on ${sshHost} but not running: ${provisioned.blocked}`
          );
          ctx.presenter.note(
            "add a provider credential on the host (an API key, or " +
              `\`ssh ${sshHost} routekit accounts login codex\`), then ` +
              `\`ssh ${sshHost} routekit start\``
          );
          return;
        }
        ctx.presenter.success(
          `RouteKit ${provisioned.installedVersion ?? version} is running on ${sshHost}`
        );
        if (provisioned.gateway !== undefined) {
          ctx.presenter.line(`  gateway: ${provisioned.gateway.url}`);
        }
        if (enrolled !== undefined) {
          ctx.presenter.line(`  remote: ${enrolled.remote.name} -> ${enrolled.remote.gatewayUrl}`);
          if (enrolled.versionMismatch !== undefined) {
            ctx.presenter.warn(
              `client v${routekitVersion()} differs from remote v${enrolled.versionMismatch}; ` +
                "compatible control protocol accepted"
            );
          }
          if (enrolled.remote.active) {
            ctx.presenter.note(`${enrolled.remote.name} is now the active remote`);
          }
        } else {
          // The daemon binds loopback; a shared gateway needs the operator's
          // own HTTPS front door before a client can enroll it.
          ctx.presenter.note(
            "expose the gateway over HTTPS, then run " +
              `\`routekit remote add ${remoteNameFromSshHost(sshHost) ?? "<name>"} ` +
              `--url <https-url> --ssh ${sshHost}\``
          );
        }
      }
    );
}

export function registerRemote(program: Command): void {
  const remote = program.command("remote").description("manage shared RouteKit gateways");

  registerRemoteInstall(remote);

  remote
    .command("add <name>")
    .description("add a remote gateway and obtain its token over SSH")
    .requiredOption("--url <https-url>", "public RouteKit gateway URL")
    .requiredOption("--ssh <host>", "SSH host used for remote administration")
    .option("--no-use", "add without making this the active remote")
    .action(
      async (
        name: string,
        options: { url: string; ssh: string; use: boolean },
        command: Command
      ) => {
        const ctx = contextFor(command);
        validateRemoteName(name);
        const gatewayUrl = normalizeRemoteUrl(options.url);
        validateSshHost(options.ssh);
        const enrolled = await enrollRemote({
          name,
          gatewayUrl,
          sshHost: options.ssh,
          use: options.use
        });
        if (ctx.json) ctx.emit(enrolled.remote);
        else {
          ctx.presenter.success(`added RouteKit remote ${name}`);
          ctx.presenter.line(`  gateway: ${gatewayUrl}`);
          ctx.presenter.line(`  control: ssh ${options.ssh}`);
          if (enrolled.versionMismatch !== undefined) {
            ctx.presenter.warn(
              `client v${routekitVersion()} differs from remote v${enrolled.versionMismatch}; ` +
                "compatible control protocol accepted"
            );
          }
          if (enrolled.remote.active) {
            ctx.presenter.note(`${name} is now the active remote`);
          }
        }
      }
    );

  remote
    .command("list")
    .description("list configured remote gateways")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const registry = readRemoteRegistry();
      const rows = await Promise.all(
        registry.remotes.map(async (entry) => ({
          ...entry,
          active: registry.active === entry.name,
          token: (await readRemoteToken(entry.name)) === undefined ? "missing" : "stored"
        }))
      );
      if (ctx.json) ctx.emit({ active: registry.active, remotes: rows });
      else if (rows.length === 0) {
        ctx.presenter.note("no RouteKit remotes configured");
      } else {
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
    });

  remote
    .command("show [name]")
    .description("show and probe one remote gateway")
    .action(async (name: string | undefined, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const selected = name === undefined ? activeRemote() : findRemote(name);
      if (selected === undefined) {
        throw new Error(
          name === undefined ? "no active RouteKit remote" : `unknown RouteKit remote: ${name}`
        );
      }
      const result = await details(selected);
      if (ctx.json) ctx.emit(result);
      else ctx.presenter.keyValue([
        { label: "Name", value: result.name + (result.active ? " (active)" : "") },
        { label: "Gateway", value: result.gatewayUrl },
        { label: "SSH", value: result.sshHost },
        { label: "Health", value: result.healthy ? "reachable" : "unreachable" },
        { label: "Token", value: result.token },
        { label: "Version", value: result.remoteVersion ?? "unavailable" },
        { label: "Protocol", value: result.protocol ?? "unavailable" }
      ]);
    });

  remote
    .command("use [name]")
    .description("select the active remote, or return to local mode")
    .option("--none", "clear the active remote and use the local daemon")
    .action((name: string | undefined, options: { none?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      if (options.none === true && name !== undefined) {
        throw new Error("provide a remote name or --none, not both");
      }
      if (options.none !== true && name === undefined) {
        throw new Error("provide a remote name or --none");
      }
      useRemote(options.none === true ? undefined : name);
      const result = { active: options.none === true ? null : name };
      if (ctx.json) ctx.emit(result);
      else if (options.none === true) {
        ctx.presenter.success("RouteKit now targets the local daemon");
      }
      else ctx.presenter.success(`RouteKit now targets remote ${name}`);
    });

  remote
    .command("remove <name>")
    .description("remove a remote gateway and its stored token")
    .action(async (name: string, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const removed = await removeRemote(name);
      if (!removed) throw new Error(`unknown RouteKit remote: ${name}`);
      if (ctx.json) ctx.emit({ name, removed: true });
      else ctx.presenter.success(`removed RouteKit remote ${name}`);
    });
}
