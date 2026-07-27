import { hostname as osHostname } from "node:os";

import { CliError, contextFor } from "@velum-labs/routekit-cli-core";
import { ROUTEKIT_CONTROL_CAPABILITY } from "@velum-labs/routekit-control";
import { decodeJoinCredential } from "@velum-labs/routekit-runtime";
import type { Command } from "commander";

import { resolveCredentialArgument } from "../credentials.js";
import { PEER_ADD_SCRIPT } from "../generated/shell-scripts.js";
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
  redactSensitiveText,
  remoteShellArgv,
  runSshCommand,
  sshExitError
} from "../ssh-exec.js";
import { routekitVersion } from "../state.js";

/**
 * Issue a named, revocable data-plane token over the SSH control relay so each
 * enrolling client gets its own credential.
 */
async function bootstrapToken(remote: RouteKitRemote): Promise<string> {
  const label = `remote-${remote.name}@${osHostname().replace(/[^a-zA-Z0-9._@-]/g, "-").slice(0, 32)}`;
  try {
    const issued = await remoteControlClient(remote).call("tokens.issue", {
      label,
      plane: "data",
      createdBy: `remote-add:${remote.name}`
    });
    if (typeof issued.token === "string" && issued.token.length > 0) {
      return issued.token;
    }
    throw new Error("remote RouteKit returned no gateway token");
  } catch (error) {
    const failure = classifySshFailure(error);
    if (failure.missingSshClient) {
      throw new Error(
        "ssh was not found on PATH; install an SSH client before adding a remote"
      );
    }
    throw new CliError({
      message:
        "could not issue a named data-plane token over SSH" +
        (failure.detail.length > 0 ? `: ${failure.detail}` : ""),
      hint: "upgrade the remote CLI so it supports `tokens.issue`, then retry"
    });
  }
}

/**
 * Enroll the SSH account as a peer of the shared daemon before remote
 * enrollment. The join credential travels on stdin so it never appears in
 * remote argv.
 */
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
      throw new Error(
        "ssh was not found on PATH; install an SSH client before adding a remote"
      );
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

/**
 * Prefer the JSON error body from `peer add --json` (stdout). Fall back to
 * stderr lines that look like RouteKit errors, ignoring SSH host-key and
 * locale noise that otherwise drown the real cause.
 */
function peerAddFailureDetail(
  stdout: string,
  stderr: string,
  secrets: Iterable<string>
): string {
  const trimmedOut = stdout.trim();
  if (trimmedOut.length > 0) {
    try {
      const parsed = JSON.parse(trimmedOut) as {
        error?: { message?: unknown };
        peer?: unknown;
      };
      if (typeof parsed.error?.message === "string" && parsed.error.message.length > 0) {
        return redactSensitiveText(parsed.error.message, secrets);
      }
    } catch {
      // Not JSON — fall through to stderr.
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

export type EnrolledPeer = {
  publicRecordPath: string;
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
    const token = await bootstrapToken(candidate);
    await writeRemoteToken(input.name, token);
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
    .option(
      "--join <join-credential>",
      "enroll the SSH account as a peer first (pass - to read from stdin)"
    )
    .option("--no-use", "add without making this the active remote")
    .action(
      async (
        name: string,
        options: { url: string; ssh: string; join?: string; use: boolean },
        command: Command
      ) => {
        const ctx = contextFor(command);
        validateRemoteName(name);
        const gatewayUrl = normalizeRemoteUrl(options.url);
        validateSshHost(options.ssh);
        let peer: EnrolledPeer | undefined;
        if (options.join !== undefined) {
          const joinCredential = await resolveCredentialArgument(options.join);
          peer = await enrollPeerOverSsh({
            sshHost: options.ssh,
            joinCredential
          });
        }
        const enrolled = await enrollRemote({
          name,
          gatewayUrl,
          sshHost: options.ssh,
          use: options.use
        });
        if (ctx.json) {
          ctx.emit({
            remote: enrolled.remote,
            ...(peer !== undefined ? { peer } : {})
          });
          return;
        }
        ctx.presenter.success(`added RouteKit remote ${name}`);
        ctx.presenter.line(`  gateway: ${gatewayUrl}`);
        ctx.presenter.line(`  control: ssh ${options.ssh}`);
        if (peer !== undefined) {
          ctx.presenter.line(`  peer: ${peer.publicRecordPath}`);
        }
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
