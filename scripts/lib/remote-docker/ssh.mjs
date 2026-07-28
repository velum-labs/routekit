import { writeFileSync } from "node:fs";

import { REMOTE_PATH_EXPORT, ROUTEKIT_PACKAGE } from "./constants.mjs";

export function withRemotePath(command) {
  return `${REMOTE_PATH_EXPORT}; ${command}`;
}

/** Install RouteKit into a user-owned prefix without starting a daemon. */
export function privateCliInstallCommand(version) {
  return [
    "set -eu",
    'export PATH="$HOME/.local/bin:$PATH"',
    'npm config set prefix "$HOME/.local"',
    `npm install -g --prefix "$HOME/.local" ${ROUTEKIT_PACKAGE}@${version}`,
    "command -v routekit",
    "routekit version"
  ].join(" && ");
}

export function writeSshConfig(filePath, input) {
  const blocks = input.hosts.map((host) =>
    [
      `Host ${host.alias}`,
      `  HostName ${host.host}`,
      `  Port ${host.port}`,
      `  User ${host.user}`,
      `  IdentityFile ${host.identityFile}`,
      "  IdentitiesOnly yes",
      "  BatchMode yes",
      "  StrictHostKeyChecking no",
      "  UserKnownHostsFile /dev/null",
      "  GlobalKnownHostsFile /dev/null",
      "  LogLevel ERROR",
      ""
    ].join("\n")
  );
  const contents = blocks.join("\n");
  writeFileSync(filePath, contents, { mode: 0o600 });
  return contents;
}

export function writeSshWrapper(filePath, configPath) {
  writeFileSync(
    filePath,
    `#!/bin/sh\nexec /usr/bin/ssh -F ${JSON.stringify(configPath)} "$@"\n`,
    { mode: 0o755 }
  );
}
