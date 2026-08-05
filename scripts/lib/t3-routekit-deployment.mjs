import { createHash } from "node:crypto";

export const DEPLOYMENT_VERSION = 5;
export const DEFAULT_DEPLOYMENT_ID = "default";
export const DEFAULT_PORT = 3773;
export const DEFAULT_T3_VERSION = "0.0.31";
export const DEFAULT_ROUTEKIT_REMOTE = "mini";
export const DEFAULT_T3_SSH_REMOTE = "velum-mini";
export const KEYCHAIN_SERVICE = "routekit-t3";
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SAFE_REMOTE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_MACOS_USER = /^[a-z_][a-z0-9_-]{0,31}$/i;
const SAFE_LINUX_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

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

export function assertMacosUser(value) {
  if (typeof value !== "string" || !SAFE_MACOS_USER.test(value) || value === "root") {
    throw new Error("--sudo-user must name a non-root local macOS user");
  }
  return value;
}

export function assertLinuxServiceUser(value) {
  if (typeof value !== "string" || !SAFE_LINUX_USER.test(value) || value === "root") {
    throw new Error("--service-user must name a non-root Linux user");
  }
  return value;
}

export function buildSystemdDropIn(environmentFile) {
  if (
    typeof environmentFile !== "string" ||
    !environmentFile.startsWith("/") ||
    /[\r\n]/.test(environmentFile)
  ) {
    throw new Error("systemd environment file must be an absolute path without newlines");
  }
  return `[Service]\nEnvironmentFile=${environmentFile}\n`;
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
    "baseDir",
    "home"
  ];
  for (const field of required) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw new Error(`wrapper input ${field} must be a non-empty string`);
    }
  }
  assertPort(input.port);
  if (!input.home.startsWith("/")) throw new Error("wrapper input home must be an absolute path");
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
export HOME=${shellQuote(input.home)}
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
/bin/launchctl setenv ROUTEKIT_GATEWAY_TOKEN "$ROUTEKIT_GATEWAY_TOKEN"
/bin/launchctl setenv ANTHROPIC_AUTH_TOKEN "$ANTHROPIC_AUTH_TOKEN"
/bin/launchctl setenv ANTHROPIC_BASE_URL "$ANTHROPIC_BASE_URL"
/bin/launchctl setenv CLAUDE_CODE_ALWAYS_ENABLE_EFFORT "$CLAUDE_CODE_ALWAYS_ENABLE_EFFORT"
exec ${shellQuote(input.t3Path)} serve --host 127.0.0.1 --port ${String(input.port)} --base-dir ${shellQuote(input.baseDir)}
`;
}

export function buildHeadlessWrapper(input) {
  const required = [
    "t3Path",
    "nodePath",
    "codexPath",
    "claudePath",
    "codexTokenPath",
    "claudeTokenPath",
    "codexLaunchArgs",
    "claudeBaseUrl",
    "baseDir",
    "home"
  ];
  for (const field of required) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw new Error(`headless wrapper input ${field} must be a non-empty string`);
    }
  }
  assertPort(input.port);
  if (!input.home.startsWith("/"))
    throw new Error("headless wrapper input home must be an absolute path");
  for (const field of ["codexTokenPath", "claudeTokenPath"]) {
    if (!input[field].startsWith("/"))
      throw new Error(`headless wrapper input ${field} must be an absolute path`);
  }
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
export HOME=${shellQuote(input.home)}
ROUTEKIT_GATEWAY_TOKEN=$(<${shellQuote(input.codexTokenPath)})
ANTHROPIC_AUTH_TOKEN=$(<${shellQuote(input.claudeTokenPath)})
if [ -z "$ROUTEKIT_GATEWAY_TOKEN" ] || [ -z "$ANTHROPIC_AUTH_TOKEN" ]; then
  print -u2 -- "RouteKit T3 deployment is missing a deployment-owned credential file"
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

export function buildT3SshShim(input) {
  if (typeof input.entryPath !== "string" || !input.entryPath.startsWith("/")) {
    throw new Error("T3 SSH shim entryPath must be an absolute path");
  }
  return `#!/bin/zsh
set -eu
read_gui_environment() {
  local key="$1"
  /bin/launchctl print "gui/$(/usr/bin/id -u)" 2>/dev/null | /usr/bin/awk -v key="$key" '
    $1 == key && $2 == "=>" {
      sub(/^[^=]*=>[[:space:]]*/, "")
      if ($0 ~ /^".*"$/) {
        sub(/^"/, "")
        sub(/"$/, "")
      }
      print
      exit
    }
  '
}
for key in \\
  ROUTEKIT_GATEWAY_TOKEN \\
  ANTHROPIC_AUTH_TOKEN \\
  ANTHROPIC_BASE_URL \\
  CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
do
  value="$(read_gui_environment "$key")"
  if [ -n "$value" ]; then
    export "$key=$value"
  fi
done
exec ${shellQuote(input.entryPath)} "$@"
`;
}

export function buildHeadlessT3SshShim(input) {
  for (const field of [
    "entryPath",
    "codexTokenPath",
    "claudeTokenPath",
    "codexLaunchArgs",
    "claudeBaseUrl"
  ]) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw new Error(`headless T3 SSH shim ${field} must be a non-empty string`);
    }
  }
  for (const field of ["entryPath", "codexTokenPath", "claudeTokenPath"]) {
    if (!input[field].startsWith("/"))
      throw new Error(`headless T3 SSH shim ${field} must be an absolute path`);
  }
  return `#!/bin/zsh
set -eu
umask 077
export ROUTEKIT_GATEWAY_TOKEN=$(<${shellQuote(input.codexTokenPath)})
export ANTHROPIC_AUTH_TOKEN=$(<${shellQuote(input.claudeTokenPath)})
export ANTHROPIC_BASE_URL=${shellQuote(input.claudeBaseUrl)}
export CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1
export T3CODE_CODEX_LAUNCH_ARGS=${shellQuote(input.codexLaunchArgs)}
exec ${shellQuote(input.entryPath)} "$@"
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

export function buildLaunchDaemonPlist(input) {
  if (!input.label.startsWith("com.velum.routekit.t3.")) {
    throw new Error("LaunchDaemon label is not RouteKit T3-owned");
  }
  assertMacosUser(input.userName);
  for (const field of ["home", "wrapperPath", "stdoutPath", "stderrPath", "workingDirectory"]) {
    if (typeof input[field] !== "string" || !input[field].startsWith("/")) {
      throw new Error(`LaunchDaemon ${field} must be an absolute path`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(input.label)}</string>
  <key>UserName</key>
  <string>${xml(input.userName)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(input.home)}</string>
  </dict>
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
    local: false,
    routekit: undefined,
    routekitRemote: undefined,
    port: DEFAULT_PORT,
    projects: [],
    deploymentId: DEFAULT_DEPLOYMENT_ID,
    t3Version: DEFAULT_T3_VERSION,
    upgradeT3: false,
    yes: false,
    headless: false,
    sudoUser: undefined,
    serviceUser: undefined,
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
      case "--local":
        result.local = true;
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
      case "--headless":
        result.headless = true;
        break;
      case "--sudo-user":
        result.sudoUser = assertMacosUser(next());
        break;
      case "--service-user":
        result.serviceUser = assertLinuxServiceUser(next());
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
  if (result.ssh !== undefined && result.local) {
    throw new Error("use either --local or --ssh <host>, not both");
  }
  if (result.ssh === undefined && !result.local) {
    throw new Error("choose --local or --ssh <host>");
  }
  if (result.routekit !== undefined && result.routekitRemote !== undefined) {
    throw new Error("use either --routekit local or --routekit-remote <name>, not both");
  }
  if (result.routekitRemote !== undefined)
    result.routekit = { kind: "remote", name: result.routekitRemote };
  if (result.routekit === undefined) {
    result.routekit = result.local
      ? { kind: "remote", name: DEFAULT_ROUTEKIT_REMOTE }
      : { kind: "local" };
  }
  delete result.routekitRemote;
  if (result.upgradeT3 && !result.yes) {
    throw new Error("--upgrade-t3 requires --yes");
  }
  if (result.headless && (result.local || result.sudoUser === undefined)) {
    throw new Error("--headless requires --ssh <host> and --sudo-user <local-user>");
  }
  if (!result.headless && result.sudoUser !== undefined) {
    throw new Error("--sudo-user requires --headless");
  }
  if (result.serviceUser !== undefined && result.local) {
    throw new Error("--service-user requires --ssh <host>");
  }
  if (result.serviceUser !== undefined && (result.headless || result.sudoUser !== undefined)) {
    throw new Error(
      "--service-user is for Linux and cannot be combined with macOS headless options"
    );
  }
  return result;
}

export function parseDestroyArgs(argv) {
  const result = {
    ssh: undefined,
    local: false,
    deploymentId: DEFAULT_DEPLOYMENT_ID,
    headless: false,
    sudoUser: undefined,
    serviceUser: undefined,
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
      case "--local":
        result.local = true;
        break;
      case "--deployment-id":
        result.deploymentId = assertDeploymentId(next());
        break;
      case "--headless":
        result.headless = true;
        break;
      case "--sudo-user":
        result.sudoUser = assertMacosUser(next());
        break;
      case "--service-user":
        result.serviceUser = assertLinuxServiceUser(next());
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
  if (result.ssh !== undefined && result.local) {
    throw new Error("use either --local or --ssh <host>, not both");
  }
  if (result.ssh === undefined && !result.local) {
    throw new Error("choose --local or --ssh <host>");
  }
  if (result.headless && (result.local || result.sudoUser === undefined)) {
    throw new Error("--headless requires --ssh <host> and --sudo-user <local-user>");
  }
  if (!result.headless && result.sudoUser !== undefined) {
    throw new Error("--sudo-user requires --headless");
  }
  if (result.serviceUser !== undefined && result.local) {
    throw new Error("--service-user requires --ssh <host>");
  }
  if (result.serviceUser !== undefined && (result.headless || result.sudoUser !== undefined)) {
    throw new Error(
      "--service-user is for Linux and cannot be combined with macOS headless options"
    );
  }
  return result;
}

export function deployUsage() {
  return `Usage: pnpm t3:deploy -- (--local | --ssh <host>) [options]\n\nDefaults:\n  --local                    Provisions this Mac through RouteKit remote ${DEFAULT_ROUTEKIT_REMOTE}\n                             and registers T3 SSH environment ${DEFAULT_T3_SSH_REMOTE}\n  --ssh <host>               Provisions that host through its local RouteKit gateway\n\nLocal prerequisite:\n  Quit T3 Code before --local so its encrypted connection catalog can be updated safely.\n\nOptions:\n  --routekit local           Use the target host's local RouteKit gateway\n  --routekit-remote <name>   Use a named RouteKit remote on the target host\n  --port <port>              Loopback T3 port (default: ${DEFAULT_PORT})\n  --project <absolute-path>  Add a project to this user's normal T3 state (repeatable)\n  --t3-version <version>     Exact T3 version (default: ${DEFAULT_T3_VERSION})\n  --upgrade-t3 --yes         Explicitly replace a different installed T3 version\n  --service-user <name>      Linux systemd user (default: the SSH account)\n  --headless                 Install a macOS system LaunchDaemon (SSH targets only)\n  --sudo-user <local-user>   Run the LaunchDaemon as this non-root macOS user\n  --dry-run                  Inspect and print the plan without changing the target\n`;
}

export function destroyUsage() {
  return `Usage: pnpm t3:destroy -- (--local | --ssh <host>) [options]\n\nOptions:\n  --deployment-id <id>  Deployment id (default: ${DEFAULT_DEPLOYMENT_ID})\n  --service-user <name> Linux systemd user (default: the SSH account)\n  --headless            Remove a macOS system LaunchDaemon (SSH targets only)\n  --sudo-user <user>    Local macOS user that owns the headless deployment\n  --dry-run              Inspect and print the destroy plan without changing the target\n`;
}
