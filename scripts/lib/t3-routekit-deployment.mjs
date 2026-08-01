import { createHash } from "node:crypto";

export const DEPLOYMENT_VERSION = 1;
export const DEFAULT_DEPLOYMENT_ID = "default";
export const DEFAULT_PORT = 3774;
export const DEFAULT_T3_VERSION = "0.0.31";
export const KEYCHAIN_SERVICE = "routekit-t3";
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SAFE_REMOTE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function shellQuote(value) {
  if (typeof value !== "string") throw new Error("shell values must be strings");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function assertDeploymentId(value) {
  if (!SAFE_ID.test(value)) {
    throw new Error(
      "deployment id must start with a letter or number and contain only letters, numbers, ., _, or -"
    );
  }
  return value;
}

export function assertRoutekitRemote(value) {
  if (!SAFE_REMOTE.test(value)) {
    throw new Error(
      "RouteKit remote name must start with a letter or number and contain only letters, numbers, ., _, or -"
    );
  }
  return value;
}

export function assertPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("--port must be an integer from 1024 through 65535");
  }
  return port;
}

export function assertT3Version(value) {
  if (!SAFE_VERSION.test(value)) {
    throw new Error("--t3-version must be an exact semver release, for example 0.0.31");
  }
  return value;
}

export function assertSshHost(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.startsWith("-") ||
    /[\s\u0000]/.test(value)
  ) {
    throw new Error("--ssh must be a non-empty SSH alias or destination without whitespace");
  }
  return value;
}

export function deploymentNames(id = DEFAULT_DEPLOYMENT_ID) {
  assertDeploymentId(id);
  return { id, label: `com.velum.routekit.t3.${id}` };
}

export function routekitTargetArgs(routekit) {
  if (routekit.kind === "local") return ["--local"];
  if (routekit.kind === "remote") return ["--remote", assertRoutekitRemote(routekit.name)];
  throw new Error("RouteKit target must be local or a named remote");
}

function routekitCommandArgs(argv) {
  const command = [...argv];
  while (command[0] === "--local" || command[0] === "--json" || command[0] === "--remote") {
    if (command[0] === "--remote") {
      const name = command[1];
      if (typeof name !== "string") return undefined;
      assertRoutekitRemote(name);
      command.splice(0, 2);
      continue;
    }
    command.shift();
  }
  return command;
}

function isDeploymentTokenPair(label, createdBy) {
  const match = /^t3-routekit-([a-z0-9][a-z0-9._-]{0,63})-([a-f0-9]{24})-(codex|claude)$/i.exec(
    label
  );
  return match !== null && createdBy === `t3-routekit:${match[1]}:${match[2]}:${match[3]}`;
}

/**
 * The deployment is deliberately restricted to the minimum RouteKit API
 * surface it needs.  This is stronger than a deny-list: future RouteKit
 * commands are rejected until they are explicitly reviewed here.
 */
export function isAllowedRoutekitArgv(argv) {
  const command = routekitCommandArgs(argv);
  if (command === undefined) return false;
  if (command.length === 1 && command[0] === "status") return true;
  if (command.length === 2 && command[0] === "models" && command[1] === "list") return true;
  if (
    command.length === 3 &&
    (command[0] === "codex" || command[0] === "claude") &&
    command[1] === "install" &&
    command[2] === "--no-token"
  ) {
    return true;
  }
  if (command.length === 2 && command[0] === "token" && command[1] === "list") return true;
  if (
    command.length === 7 &&
    command[0] === "token" &&
    command[1] === "issue" &&
    isDeploymentTokenPair(command[2], command[6]) &&
    command[3] === "--plane" &&
    command[4] === "data" &&
    command[5] === "--created-by"
  ) {
    return true;
  }
  return (
    command.length === 3 &&
    command[0] === "token" &&
    command[1] === "revoke" &&
    /^[a-f0-9]{16}$/i.test(command[2])
  );
}

export function assertSafeRoutekitArgv(argv) {
  if (!isAllowedRoutekitArgv(argv)) {
    throw new Error(`refusing non-allowlisted RouteKit operation: routekit ${argv.join(" ")}`);
  }
  return argv;
}

export function buildWrapper(input) {
  const required = [
    "t3Path",
    "nodePath",
    "codexPath",
    "claudePath",
    "codexAccount",
    "claudeAccount",
    "codexLaunchArgs",
    "claudeBaseUrl",
    "baseDir"
  ];
  for (const field of required) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw new Error(`wrapper input ${field} must be a non-empty string`);
    }
  }
  assertPort(input.port);
  const paths = [input.t3Path, input.nodePath, input.codexPath, input.claudePath]
    .map((path) => path.slice(0, path.lastIndexOf("/")))
    .filter((path) => path.length > 0);
  const pathValue = [
    ...new Set([...paths, "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
  ].join(":");
  return `#!/bin/zsh
set -eu
umask 077
export PATH=${shellQuote(pathValue)}
ROUTEKIT_GATEWAY_TOKEN=$(/usr/bin/security find-generic-password -s ${shellQuote(KEYCHAIN_SERVICE)} -a ${shellQuote(input.codexAccount)} -w)
ANTHROPIC_AUTH_TOKEN=$(/usr/bin/security find-generic-password -s ${shellQuote(KEYCHAIN_SERVICE)} -a ${shellQuote(input.claudeAccount)} -w)
if [ -z "$ROUTEKIT_GATEWAY_TOKEN" ] || [ -z "$ANTHROPIC_AUTH_TOKEN" ]; then
  print -u2 -- "RouteKit T3 deployment is missing a deployment-owned Keychain credential"
  exit 78
fi
export ROUTEKIT_GATEWAY_TOKEN
export ANTHROPIC_AUTH_TOKEN
export ANTHROPIC_BASE_URL=${shellQuote(input.claudeBaseUrl)}
export CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1
export T3CODE_CODEX_LAUNCH_ARGS=${shellQuote(input.codexLaunchArgs)}
exec ${shellQuote(input.t3Path)} serve --host 127.0.0.1 --port ${String(input.port)} --base-dir ${shellQuote(input.baseDir)}
`;
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildLaunchAgentPlist(input) {
  if (!input.label.startsWith("com.velum.routekit.t3.")) {
    throw new Error("LaunchAgent label is not RouteKit T3-owned");
  }
  for (const field of ["wrapperPath", "stdoutPath", "stderrPath", "workingDirectory"]) {
    if (typeof input[field] !== "string" || !input[field].startsWith("/")) {
      throw new Error(`LaunchAgent ${field} must be an absolute path`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(input.wrapperPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(input.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(input.stderrPath)}</string>
</dict>
</plist>
`;
}

export function parseDeployArgs(argv) {
  const result = {
    ssh: undefined,
    routekit: undefined,
    routekitRemote: undefined,
    port: DEFAULT_PORT,
    projects: [],
    deploymentId: DEFAULT_DEPLOYMENT_ID,
    t3Version: DEFAULT_T3_VERSION,
    upgradeT3: false,
    yes: false,
    dryRun: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    const next = () => {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${argument} requires a value`);
      return value;
    };
    switch (argument) {
      case "--ssh":
        result.ssh = assertSshHost(next());
        break;
      case "--routekit": {
        const value = next();
        if (value !== "local") throw new Error("--routekit currently accepts only: local");
        result.routekit = { kind: "local" };
        break;
      }
      case "--routekit-remote":
        result.routekitRemote = assertRoutekitRemote(next());
        break;
      case "--port":
        result.port = assertPort(next());
        break;
      case "--project":
        result.projects.push(next());
        break;
      case "--deployment-id":
        result.deploymentId = assertDeploymentId(next());
        break;
      case "--t3-version":
        result.t3Version = assertT3Version(next());
        break;
      case "--upgrade-t3":
        result.upgradeT3 = true;
        break;
      case "--yes":
        result.yes = true;
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--help":
      case "-h":
        result.help = true;
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }
  if (result.help === true) return result;
  if (result.ssh === undefined) throw new Error("--ssh is required");
  if (result.routekit !== undefined && result.routekitRemote !== undefined) {
    throw new Error("use either --routekit local or --routekit-remote <name>, not both");
  }
  if (result.routekit === undefined && result.routekitRemote === undefined) {
    throw new Error("choose --routekit local or --routekit-remote <name>");
  }
  if (result.routekitRemote !== undefined)
    result.routekit = { kind: "remote", name: result.routekitRemote };
  delete result.routekitRemote;
  if (result.upgradeT3 && !result.yes) {
    throw new Error("--upgrade-t3 requires --yes");
  }
  return result;
}

export function parseDestroyArgs(argv) {
  const result = {
    ssh: undefined,
    deploymentId: DEFAULT_DEPLOYMENT_ID,
    dryRun: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    const next = () => {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`${argument} requires a value`);
      return value;
    };
    switch (argument) {
      case "--ssh":
        result.ssh = assertSshHost(next());
        break;
      case "--deployment-id":
        result.deploymentId = assertDeploymentId(next());
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--help":
      case "-h":
        result.help = true;
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }
  if (result.help === true) return result;
  if (result.ssh === undefined) throw new Error("--ssh is required");
  return result;
}

export function deployUsage() {
  return `Usage: pnpm t3:deploy -- --ssh <host> (--routekit local | --routekit-remote <name>) [options]\n\nOptions:\n  --port <port>              Loopback T3 port (default: ${DEFAULT_PORT})\n  --project <absolute-path>  Add a project to this deployment's isolated T3 state (repeatable)\n  --t3-version <version>     Exact T3 version (default: ${DEFAULT_T3_VERSION})\n  --upgrade-t3 --yes         Explicitly replace a different installed T3 version\n  --dry-run                  Inspect and print the plan without changing the target\n`;
}

export function destroyUsage() {
  return `Usage: pnpm t3:destroy -- --ssh <host> [options]\n\nOptions:\n  --deployment-id <id>  Deployment id (default: ${DEFAULT_DEPLOYMENT_ID})\n  --dry-run              Inspect and print the destroy plan without changing the target\n`;
}
