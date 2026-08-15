/**
 * Provision a RouteKit gateway on an SSH-reachable host.
 *
 * Each step is a shell program from `shell/remote/*.sh`, inlined at build time
 * into `generated/shell-scripts.ts` and run under the shared preamble.
 * Caller-supplied values reach it only as positional parameters, never
 * concatenated into the program text, and are additionally validated against a
 * strict charset before they are sent.
 */
import { CliError } from "@velum-labs/routekit-cli-core";

import { runCliEffect } from "./cli-session.js";
import {
  CONFIG_INIT_SCRIPT,
  INSTALL_SCRIPT,
  PROBE_SCRIPT,
  SHELL_SCRIPT_DIGESTS,
  START_SCRIPT,
  STATUS_SCRIPT
} from "./generated/shell-scripts.js";
import {
  type InstallVersionResolver,
  isExactInstallVersion,
  ROUTEKIT_PACKAGE_NAME,
  resolveInstallVersion
} from "./install-version.js";
import {
  classifySshFailure,
  redactSensitiveText,
  remoteShellArgv,
  runSshCommand,
  type SshCommandResult
} from "./ssh-exec.js";

export {
  CONFIG_INIT_SCRIPT,
  INSTALL_SCRIPT,
  PROBE_SCRIPT,
  SHELL_SCRIPT_DIGESTS,
  START_SCRIPT,
  STATUS_SCRIPT
};

export const ROUTEKIT_PACKAGE = ROUTEKIT_PACKAGE_NAME;

const PROBE_TIMEOUT_MS = 30_000;
/** Covers a cold private-Node bootstrap (~50MB) on a slow host. */
const INSTALL_TIMEOUT_MS = 600_000;
const CONFIG_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 120_000;

/**
 * Asked before starting. `routekit start` is not reliably idempotent against a
 * daemon that came up with different effective listener options than the ones
 * it was asked for, so a running daemon is queried rather than restarted.
 */

export type RemoteProbe = {
  os: string;
  arch: string;
  node?: string;
  npm?: string;
  npmPrefix?: string;
  npmPrefixWritable: boolean;
  routekit?: string;
  supervisor: "systemd" | "launchd" | "none";
  configExists: boolean;
  daemonRunning: boolean;
};

export type RemoteGateway = {
  url: string;
  port?: number;
  pid?: number;
  version?: string;
  supervisor?: string;
  alreadyRunning: boolean;
};

export type ProvisionStepId = "probe" | "install" | "config" | "start";
/**
 * `blocked` is a successful provision that stopped short of a running daemon,
 * which is the expected state of a host that has no provider credential yet.
 */
export type ProvisionStepStatus = "done" | "skipped" | "planned" | "blocked";

export type ProvisionStep = {
  id: ProvisionStepId;
  status: ProvisionStepStatus;
  detail: string;
};

export type RemoteRunner = (
  argv: readonly string[],
  options: { timeoutMs: number }
) => Promise<SshCommandResult>;

export type ProvisionInput = {
  host: string;
  version: string;
  force?: boolean;
  dryRun?: boolean;
  run?: RemoteRunner;
  resolveVersion?: InstallVersionResolver;
  /** Fires before a step's remote work begins, for live progress. */
  onStepStart?: (id: ProvisionStepId) => void;
  onStep?: (step: ProvisionStep) => void;
};

export type ProvisionResult = {
  probe: RemoteProbe;
  steps: ProvisionStep[];
  targetVersion: string;
  installedVersion?: string;
  gateway?: RemoteGateway;
  /** Set when the daemon could not start yet; carries the remote's reason. */
  blocked?: string;
  /** Digests of the inlined shell programs that would run (or did run). */
  scriptDigests?: typeof SHELL_SCRIPT_DIGESTS;
};

/**
 * A version accepted for `npm install -g <package>@<version>`. Deliberately
 * narrow: dist-tags other than `latest`, ranges, and URLs are all rejected so
 * the specifier can never carry shell or npm-protocol meaning.
 */
export function validateInstallVersion(version: string): string {
  if (version !== "latest" && !isExactInstallVersion(version)) {
    throw new CliError({
      message: `invalid RouteKit version: ${JSON.stringify(version)}`,
      hint: "pass an exact version such as 0.10.1, or `latest`"
    });
  }
  return version;
}

export function installSpecifier(version: string): string {
  return `${ROUTEKIT_PACKAGE}@${validateInstallVersion(version)}`;
}

/**
 * Positional parameters survive one round of remote-shell word splitting, so
 * every argument must be a single bare word.
 */
function stepArgv(script: string, args: readonly string[]): string[] {
  for (const arg of args) {
    if (!/^[A-Za-z0-9@._/-]+$/.test(arg)) {
      throw new CliError({
        message: `unsafe remote argument: ${JSON.stringify(arg)}`
      });
    }
  }
  return remoteShellArgv(script, args);
}

/** Derive a remote registry name from an SSH destination. */
export function remoteNameFromSshHost(sshHost: string): string | undefined {
  const withoutUser = sshHost.includes("@") ? sshHost.slice(sshHost.lastIndexOf("@") + 1) : sshHost;
  const withoutBrackets = withoutUser.startsWith("[")
    ? withoutUser.slice(1, withoutUser.indexOf("]") > 0 ? withoutUser.indexOf("]") : undefined)
    : (withoutUser.split(":")[0] ?? withoutUser);
  const candidate = withoutBrackets.trim();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(candidate) ? candidate : undefined;
}

export function parseProbe(stdout: string): RemoteProbe {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const optional = (key: string): string | undefined => {
    const value = values.get(key);
    return value !== undefined && value.length > 0 ? value : undefined;
  };
  const supervisor = values.get("supervisor");
  return {
    os: optional("os") ?? "unknown",
    arch: optional("arch") ?? "unknown",
    ...(optional("node") !== undefined ? { node: optional("node") } : {}),
    ...(optional("npm") !== undefined ? { npm: optional("npm") } : {}),
    ...(optional("npmPrefix") !== undefined ? { npmPrefix: optional("npmPrefix") } : {}),
    npmPrefixWritable: values.get("npmPrefixWritable") === "yes",
    ...(optional("routekit") !== undefined ? { routekit: optional("routekit") } : {}),
    supervisor: supervisor === "systemd" || supervisor === "launchd" ? supervisor : "none",
    configExists: values.get("config") === "yes",
    daemonRunning: values.get("daemon") === "yes"
  };
}

/** The major version of a `vX.Y.Z` string, or undefined when unparseable. */
export function nodeMajor(version: string | undefined): number | undefined {
  const match = version?.match(/^v?(\d+)\./);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

function jsonObject(stdout: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/** `routekit start` reports the gateway it just brought up as `url`. */
function parseStartResult(stdout: string): RemoteGateway | undefined {
  const record = jsonObject(stdout);
  if (record === undefined || typeof record.url !== "string") return undefined;
  return {
    url: record.url,
    ...(typeof record.port === "number" ? { port: record.port } : {}),
    ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
    ...(typeof record.version === "string" ? { version: record.version } : {}),
    ...(typeof record.supervisor === "string" ? { supervisor: record.supervisor } : {}),
    alreadyRunning: record.alreadyRunning === true
  };
}

/**
 * `routekit status` nests a healthy daemon's data plane under `daemon.dataUrl`,
 * and degrades to `{ running, healthy }` when it cannot reach one.
 */
function parseDaemonStatus(stdout: string): RemoteGateway | undefined {
  const record = jsonObject(stdout);
  const daemon =
    record !== undefined &&
    typeof record.daemon === "object" &&
    record.daemon !== null &&
    !Array.isArray(record.daemon)
      ? (record.daemon as Record<string, unknown>)
      : undefined;
  if (daemon === undefined || typeof daemon.dataUrl !== "string") return undefined;
  return {
    url: daemon.dataUrl,
    ...(typeof daemon.dataPort === "number" ? { port: daemon.dataPort } : {}),
    ...(typeof daemon.pid === "number" ? { pid: daemon.pid } : {}),
    ...(typeof daemon.packageVersion === "string" ? { version: daemon.packageVersion } : {}),
    ...(typeof daemon.supervisor === "string" ? { supervisor: daemon.supervisor } : {}),
    alreadyRunning: true
  };
}

function sshRunner(host: string): RemoteRunner {
  return async (argv, options) => await runSshCommand(host, argv, { timeoutMs: options.timeoutMs });
}

function provisionFailure(input: { host: string; step: string; error: unknown }): CliError {
  const failure = classifySshFailure(input.error);
  if (failure.missingSshClient) {
    return new CliError({
      message: "ssh was not found on PATH; install an SSH client before provisioning a remote",
      code: "unavailable"
    });
  }
  return new CliError({
    message:
      `RouteKit ${input.step} on ${input.host} failed` +
      (failure.detail.length > 0 ? `: ${failure.detail}` : ""),
    code: failure.code
  });
}

/** The last few lines of remote stderr, redacted, for error details. */
function evidence(stderr: string): string[] {
  return redactSensitiveText(stderr)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-5);
}

/** The message from a remote `--json` failure payload, when there is one. */
export function remoteErrorMessage(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim()) as unknown;
  } catch {
    return undefined;
  }
  const error = (parsed as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" ? error.message : undefined;
}

type StepContext = { host: string; step: string; run: RemoteRunner };

async function runStep(
  input: StepContext,
  script: string,
  options: { args?: readonly string[]; timeoutMs: number }
): Promise<SshCommandResult> {
  try {
    return await input.run(stepArgv(script, options.args ?? []), {
      timeoutMs: options.timeoutMs
    });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw provisionFailure({ host: input.host, step: input.step, error });
  }
}

function requireSuccess(result: SshCommandResult, input: StepContext): SshCommandResult {
  if (result.exitCode === 0) return result;
  const reported = remoteErrorMessage(result.stdout);
  throw new CliError({
    message:
      `RouteKit ${input.step} on ${input.host} failed` +
      (reported === undefined ? ` (exit ${result.exitCode})` : `: ${reported}`),
    details: evidence(result.stderr)
  });
}

async function step(
  input: StepContext,
  script: string,
  options: { args?: readonly string[]; timeoutMs: number }
): Promise<SshCommandResult> {
  return requireSuccess(await runStep(input, script, options), input);
}

export async function probeRemoteHost(input: {
  host: string;
  run?: RemoteRunner;
}): Promise<RemoteProbe> {
  const run = input.run ?? sshRunner(input.host);
  const result = await step({ host: input.host, step: "host probe", run }, PROBE_SCRIPT, {
    timeoutMs: PROBE_TIMEOUT_MS
  });
  return parseProbe(result.stdout);
}

/**
 * Reject hosts the installer cannot bootstrap. Missing or old Node.js, and a
 * non-writable npm prefix, are no longer fatal: the inlined installer prefers
 * system npm when usable and otherwise downloads a pinned private Node runtime.
 */
export function assertInstallable(probe: RemoteProbe, host: string): void {
  if (probe.os !== "Linux" && probe.os !== "Darwin") {
    throw new CliError({
      message: `${host} runs ${probe.os}, which RouteKit cannot provision yet`,
      hint: "RouteKit remote install supports Linux and macOS hosts"
    });
  }
}

/**
 * Bring `host` to a running RouteKit daemon. Every step is idempotent: an
 * up-to-date install, an existing canonical config, and an already-running
 * daemon are all reported as skipped rather than replayed.
 */
export async function provisionRemoteHost(input: ProvisionInput): Promise<ProvisionResult> {
  const requestedVersion = validateInstallVersion(input.version);
  const targetVersion =
    input.resolveVersion === undefined
      ? await runCliEffect(resolveInstallVersion(requestedVersion))
      : await input.resolveVersion(requestedVersion);
  const run = input.run ?? sshRunner(input.host);
  const context = { host: input.host, run };
  const steps: ProvisionStep[] = [];
  const record = (id: ProvisionStepId, status: ProvisionStepStatus, detail: string): void => {
    const entry: ProvisionStep = { id, status, detail };
    steps.push(entry);
    input.onStep?.(entry);
  };

  input.onStepStart?.("probe");
  const probe = await probeRemoteHost({ host: input.host, run });
  record("probe", "done", `${probe.os} ${probe.arch} · node ${probe.node ?? "missing"}`);

  const upToDate = probe.routekit === targetVersion && input.force !== true;
  if (!upToDate) assertInstallable(probe, input.host);

  if (input.dryRun === true) {
    record(
      "install",
      upToDate ? "skipped" : "planned",
      upToDate ? `already ${targetVersion}` : `${installSpecifier(targetVersion)} via install.sh`
    );
    record(
      "config",
      probe.configExists ? "skipped" : "planned",
      probe.configExists ? "canonical config exists" : "~/.config/routekit/router.yaml"
    );
    record(
      "start",
      "planned",
      probe.daemonRunning ? "already recorded; start is idempotent" : "not running yet"
    );
    return { probe, steps, targetVersion, scriptDigests: SHELL_SCRIPT_DIGESTS };
  }

  let installedVersion = probe.routekit;
  if (upToDate) {
    record("install", "skipped", `already ${targetVersion}`);
  } else {
    input.onStepStart?.("install");
    const result = await step({ ...context, step: "installation" }, INSTALL_SCRIPT, {
      args: ["--version", targetVersion],
      timeoutMs: INSTALL_TIMEOUT_MS
    });
    installedVersion = result.stdout.trim().split("\n").pop()?.trim();
    record("install", "done", `installed ${installedVersion ?? targetVersion}`);
  }

  if (probe.configExists) {
    record("config", "skipped", "canonical config exists");
  } else {
    input.onStepStart?.("config");
    await step({ ...context, step: "config init" }, CONFIG_INIT_SCRIPT, {
      timeoutMs: CONFIG_TIMEOUT_MS
    });
    record("config", "done", "created ~/.config/routekit/router.yaml");
  }

  input.onStepStart?.("start");
  const startContext = { ...context, step: "start" };
  const observed = await runStep({ ...context, step: "status" }, STATUS_SCRIPT, {
    timeoutMs: STATUS_TIMEOUT_MS
  });
  const running = observed.exitCode === 0 ? parseDaemonStatus(observed.stdout) : undefined;
  if (running !== undefined) {
    record("start", "done", `already running at ${running.url}`);
    return {
      probe,
      steps,
      targetVersion,
      ...(installedVersion !== undefined ? { installedVersion } : {}),
      gateway: running,
      scriptDigests: SHELL_SCRIPT_DIGESTS
    };
  }
  const started = await runStep(startContext, START_SCRIPT, {
    timeoutMs: START_TIMEOUT_MS
  });
  if (started.exitCode !== 0) {
    // A host with no provider credential cannot start a daemon yet. That is
    // the ordinary state of a freshly provisioned machine, not a failure of
    // the provisioning itself, so it is reported rather than thrown.
    const reported = remoteErrorMessage(started.stdout);
    if (reported === undefined || !/^cannot start RouteKit: /.test(reported)) {
      requireSuccess(started, startContext);
    }
    record("start", "blocked", reported ?? "the remote daemon did not start");
    return {
      probe,
      steps,
      targetVersion,
      ...(installedVersion !== undefined ? { installedVersion } : {}),
      blocked: reported ?? "the remote daemon did not start",
      scriptDigests: SHELL_SCRIPT_DIGESTS
    };
  }
  const gateway = parseStartResult(started.stdout);
  if (gateway === undefined) {
    throw new CliError({
      message: `RouteKit start on ${input.host} did not report a gateway URL`,
      details: evidence(started.stderr)
    });
  }
  record(
    "start",
    "done",
    gateway.alreadyRunning ? `already running at ${gateway.url}` : `started at ${gateway.url}`
  );

  return {
    probe,
    steps,
    targetVersion,
    ...(installedVersion !== undefined ? { installedVersion } : {}),
    gateway,
    scriptDigests: SHELL_SCRIPT_DIGESTS
  };
}
