/**
 * Provision a RouteKit gateway on an SSH-reachable host.
 *
 * Every step ships its shell program over stdin to `sh -s` and passes
 * caller-supplied values as positional parameters, so nothing user-controlled
 * is ever concatenated into a command line the remote shell parses. Values are
 * additionally validated against a strict charset before they are sent.
 *
 * `ssh host <command>` does not run a login shell, so an nvm- or Homebrew-
 * installed Node is routinely absent from the default non-interactive PATH.
 * Every step therefore prepends the same explicit search path. nvm is resolved
 * by reading its directory layout rather than sourcing `nvm.sh`: that script
 * is written for bash and aborts a POSIX shell outright under a minimal
 * environment, and sourcing remote profile code is not something a
 * provisioning step should do.
 */
import { CliError } from "@velum-labs/routekit-cli-core";

import {
  classifySshFailure,
  redactSensitiveText,
  runSshCommand,
  type SshCommandResult
} from "./ssh-exec.js";

export const ROUTEKIT_PACKAGE = "@velum-labs/routekit";

/** engines.node for `@velum-labs/routekit`. */
const MINIMUM_NODE_MAJOR = 22;

const PROBE_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 300_000;
const CONFIG_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 120_000;

/**
 * Shared preamble, so probing and execution always resolve the same binaries.
 * The nvm version sort keys off the numeric parts of `vX.Y.Z` rather than
 * `sort -V`, which is not available everywhere.
 */
const PATH_PREAMBLE = [
  "set -u",
  'PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"',
  'nvm_dir=${NVM_DIR:-$HOME/.nvm}',
  'nvm_bin=""',
  'if [ -d "$nvm_dir/versions/node" ]; then',
  '  if [ -f "$nvm_dir/alias/default" ]; then',
  '    nvm_want=$(cat "$nvm_dir/alias/default" 2>/dev/null || echo "")',
  '    for nvm_name in "$nvm_want" "v$nvm_want"; do',
  '      if [ -n "$nvm_want" ] && [ -d "$nvm_dir/versions/node/$nvm_name/bin" ]; then',
  '        nvm_bin="$nvm_dir/versions/node/$nvm_name/bin"',
  "        break",
  "      fi",
  "    done",
  "  fi",
  '  if [ -z "$nvm_bin" ]; then',
  '    nvm_name=$(ls "$nvm_dir/versions/node" 2>/dev/null |',
  "      sort -t. -k1.2,1n -k2,2n -k3,3n 2>/dev/null | tail -n 1)",
  '    if [ -n "$nvm_name" ] && [ -d "$nvm_dir/versions/node/$nvm_name/bin" ]; then',
  '      nvm_bin="$nvm_dir/versions/node/$nvm_name/bin"',
  "    fi",
  "  fi",
  "fi",
  'if [ -n "$nvm_bin" ]; then PATH="$nvm_bin:$PATH"; fi',
  "export PATH"
].join("\n");

/**
 * Emits `key=value` lines. Every probe tolerates a missing tool: the caller
 * decides which absences are fatal, so the script itself always exits 0.
 */
export const PROBE_SCRIPT = [
  PATH_PREAMBLE,
  'p() { printf "%s=%s\\n" "$1" "$2"; }',
  'have() { command -v "$1" >/dev/null 2>&1; }',
  'os=$(uname -s 2>/dev/null || echo unknown)',
  'p os "$os"',
  'p arch "$(uname -m 2>/dev/null || echo unknown)"',
  'if have node; then p node "$(node --version 2>/dev/null || echo unknown)"; else p node ""; fi',
  'if have npm; then p npm "$(npm --version 2>/dev/null || echo unknown)"; else p npm ""; fi',
  'prefix=""',
  'writable=no',
  "if have npm; then",
  '  prefix=$(npm prefix -g 2>/dev/null || echo "")',
  '  if [ -n "$prefix" ]; then',
  '    if [ -w "$prefix/lib/node_modules" ]; then',
  "      writable=yes",
  '    elif [ ! -e "$prefix/lib/node_modules" ] && [ -w "$prefix" ]; then',
  "      writable=yes",
  "    fi",
  "  fi",
  "fi",
  'p npmPrefix "$prefix"',
  'p npmPrefixWritable "$writable"',
  'installed=""',
  "if have routekit; then",
  '  raw=$(routekit version 2>/dev/null | head -n 1)',
  "  # shellcheck disable=SC2086",
  "  set -- $raw",
  '  if [ "$#" -ge 2 ]; then installed=$2; else installed=unknown; fi',
  "fi",
  'p routekit "$installed"',
  "supervisor=none",
  'if [ "$os" = "Darwin" ]; then',
  "  if have launchctl; then supervisor=launchd; fi",
  "elif have systemctl; then",
  "  if systemctl --user show-environment >/dev/null 2>&1; then supervisor=systemd; fi",
  "fi",
  'p supervisor "$supervisor"',
  'if [ -f "$HOME/.config/routekit/router.yaml" ]; then p config yes; else p config no; fi',
  'state=${ROUTEKIT_HOME:-$HOME/.routekit}',
  'if [ -f "$state/services/daemon.json" ]; then p daemon yes; else p daemon no; fi',
  "exit 0"
].join("\n");

/** `$1` is the validated `<package>@<version>` specifier. */
export const INSTALL_SCRIPT = [
  PATH_PREAMBLE,
  'npm install -g "$1" >&2 || exit 1',
  'if ! command -v routekit >/dev/null 2>&1; then',
  '  echo "routekit is not on PATH after installation" >&2',
  "  exit 127",
  "fi",
  'raw=$(routekit version 2>/dev/null | head -n 1)',
  "# shellcheck disable=SC2086",
  "set -- $raw",
  'if [ "$#" -ge 2 ]; then printf "%s\\n" "$2"; else printf "unknown\\n"; fi'
].join("\n");

export const CONFIG_INIT_SCRIPT = [
  PATH_PREAMBLE,
  "routekit --local --quiet config init >&2"
].join("\n");

export const START_SCRIPT = [
  PATH_PREAMBLE,
  "routekit --local --quiet --json start"
].join("\n");

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
  options: { stdin: string; timeoutMs: number }
) => Promise<SshCommandResult>;

export type ProvisionInput = {
  host: string;
  version: string;
  force?: boolean;
  dryRun?: boolean;
  run?: RemoteRunner;
  /** Fires before a step's remote work begins, for live progress. */
  onStepStart?: (id: ProvisionStepId) => void;
  onStep?: (step: ProvisionStep) => void;
};

export type ProvisionResult = {
  probe: RemoteProbe;
  steps: ProvisionStep[];
  installedVersion?: string;
  gateway?: RemoteGateway;
  /** Set when the daemon could not start yet; carries the remote's reason. */
  blocked?: string;
};

/**
 * A version accepted for `npm install -g <package>@<version>`. Deliberately
 * narrow: dist-tags other than `latest`, ranges, and URLs are all rejected so
 * the specifier can never carry shell or npm-protocol meaning.
 */
export function validateInstallVersion(version: string): string {
  if (!/^(?:latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(version)) {
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
function remoteArgv(args: readonly string[]): string[] {
  for (const arg of args) {
    if (!/^[A-Za-z0-9@._/-]+$/.test(arg)) {
      throw new CliError({
        message: `unsafe remote argument: ${JSON.stringify(arg)}`
      });
    }
  }
  return ["sh", "-s", "--", ...args];
}

/** Derive a remote registry name from an SSH destination. */
export function remoteNameFromSshHost(sshHost: string): string | undefined {
  const withoutUser = sshHost.includes("@")
    ? sshHost.slice(sshHost.lastIndexOf("@") + 1)
    : sshHost;
  const withoutBrackets = withoutUser.startsWith("[")
    ? withoutUser.slice(1, withoutUser.indexOf("]") > 0 ? withoutUser.indexOf("]") : undefined)
    : withoutUser.split(":")[0] ?? withoutUser;
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
    supervisor:
      supervisor === "systemd" || supervisor === "launchd" ? supervisor : "none",
    configExists: values.get("config") === "yes",
    daemonRunning: values.get("daemon") === "yes"
  };
}

/** The major version of a `vX.Y.Z` string, or undefined when unparseable. */
export function nodeMajor(version: string | undefined): number | undefined {
  const match = version?.match(/^v?(\d+)\./);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

function parseGateway(stdout: string): RemoteGateway | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.url !== "string") return undefined;
  return {
    url: record.url,
    ...(typeof record.port === "number" ? { port: record.port } : {}),
    ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
    ...(typeof record.version === "string" ? { version: record.version } : {}),
    ...(typeof record.supervisor === "string" ? { supervisor: record.supervisor } : {}),
    alreadyRunning: record.alreadyRunning === true
  };
}

function sshRunner(host: string): RemoteRunner {
  return async (argv, options) =>
    await runSshCommand(host, argv, {
      stdin: options.stdin,
      timeoutMs: options.timeoutMs
    });
}

function provisionFailure(input: {
  host: string;
  step: string;
  error: unknown;
}): CliError {
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
    return await input.run(remoteArgv(options.args ?? []), {
      stdin: `${script}\n`,
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

/** Reject hosts that cannot install or run RouteKit before anything mutates. */
export function assertInstallable(probe: RemoteProbe, host: string): void {
  const major = nodeMajor(probe.node);
  if (probe.node === undefined) {
    throw new CliError({
      message: `Node.js was not found on ${host}`,
      hint: `RouteKit needs Node.js ${MINIMUM_NODE_MAJOR} or newer; install it on the host and retry`
    });
  }
  if (major !== undefined && major < MINIMUM_NODE_MAJOR) {
    throw new CliError({
      message: `${host} runs Node.js ${probe.node}`,
      hint: `RouteKit needs Node.js ${MINIMUM_NODE_MAJOR} or newer; upgrade the host and retry`
    });
  }
  if (probe.npm === undefined) {
    throw new CliError({
      message: `npm was not found on ${host}`,
      hint: "RouteKit installs from npm; install npm on the host and retry"
    });
  }
  if (!probe.npmPrefixWritable) {
    throw new CliError({
      message: `the global npm prefix on ${host} is not writable by this SSH user`,
      details:
        probe.npmPrefix === undefined ? undefined : [`npm prefix: ${probe.npmPrefix}`],
      hint:
        "RouteKit never escalates with sudo over BatchMode SSH; point npm at a user-owned " +
        "prefix (`npm config set prefix ~/.local`) or preinstall the CLI on the host"
    });
  }
}

/**
 * Bring `host` to a running RouteKit daemon. Every step is idempotent: an
 * up-to-date install, an existing canonical config, and an already-running
 * daemon are all reported as skipped rather than replayed.
 */
export async function provisionRemoteHost(
  input: ProvisionInput
): Promise<ProvisionResult> {
  const version = validateInstallVersion(input.version);
  const run = input.run ?? sshRunner(input.host);
  const context = { host: input.host, run };
  const steps: ProvisionStep[] = [];
  const record = (
    id: ProvisionStepId,
    status: ProvisionStepStatus,
    detail: string
  ): void => {
    const entry: ProvisionStep = { id, status, detail };
    steps.push(entry);
    input.onStep?.(entry);
  };

  input.onStepStart?.("probe");
  const probe = await probeRemoteHost({ host: input.host, run });
  record("probe", "done", `${probe.os} ${probe.arch} · node ${probe.node ?? "missing"}`);

  const upToDate = probe.routekit === version && input.force !== true;
  if (!upToDate) assertInstallable(probe, input.host);

  if (input.dryRun === true) {
    record(
      "install",
      upToDate ? "skipped" : "planned",
      upToDate ? `already ${version}` : installSpecifier(version)
    );
    record(
      "config",
      probe.configExists ? "skipped" : "planned",
      probe.configExists ? "canonical config exists" : "routekit config init"
    );
    record(
      "start",
      "planned",
      probe.daemonRunning ? "daemon already recorded; start is idempotent" : "routekit start"
    );
    return { probe, steps };
  }

  let installedVersion = probe.routekit;
  if (upToDate) {
    record("install", "skipped", `already ${version}`);
  } else {
    input.onStepStart?.("install");
    const result = await step(
      { ...context, step: "installation" },
      INSTALL_SCRIPT,
      { args: [installSpecifier(version)], timeoutMs: INSTALL_TIMEOUT_MS }
    );
    installedVersion = result.stdout.trim().split("\n").pop()?.trim();
    record("install", "done", `installed ${installedVersion ?? version}`);
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
      ...(installedVersion !== undefined ? { installedVersion } : {}),
      blocked: reported ?? "the remote daemon did not start"
    };
  }
  const gateway = parseGateway(started.stdout.trim());
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
    ...(installedVersion !== undefined ? { installedVersion } : {}),
    gateway
  };
}
