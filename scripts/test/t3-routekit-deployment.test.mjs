import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  assertLinuxServiceUser,
  assertSafeRoutekitArgv,
  buildHeadlessT3SshShim,
  buildHeadlessWrapper,
  buildLaunchAgentPlist,
  buildLaunchDaemonPlist,
  buildSystemdDropIn,
  buildT3SshShim,
  buildWrapper,
  DEFAULT_PORT,
  DEFAULT_ROUTEKIT_REMOTE,
  DEFAULT_T3_SSH_REMOTE,
  DEFAULT_T3_VERSION,
  DEPLOYMENT_VERSION,
  deploymentNames,
  isAllowedRoutekitArgv,
  parseDeployArgs,
  parseDestroyArgs,
  routekitTargetArgs,
  sha256
} from "../lib/t3-routekit-deployment.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);

function executable(path, content) {
  writeFileSync(path, content, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function runLinuxHelper(helper, payload, env) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-", encoded], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      try {
        resolve({
          code,
          result: JSON.parse(output),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      } catch (error) {
        reject(new Error(`Linux helper returned invalid JSON: ${output}`, { cause: error }));
      }
    });
    child.stdin.end(
      `Object.defineProperty(process, "platform", { value: "linux" });
if (process.env.TEST_FAKE_HTTP === "1") {
  globalThis.fetch = async (url) => new Response(
    String(url).endsWith("/health") ? '{"ok":true}' : '{"data":[{"id":"openai/test"}]}',
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
${helper}`
    );
  });
}

function installLinuxFixtureCommands(bin) {
  executable(
    join(bin, "routekit"),
    `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HOME;
const mkdir = (path) => mkdirSync(path, { recursive: true });
const write = (path, value) => { mkdir(join(path, "..")); writeFileSync(path, value, { mode: 0o600 }); };
const args = process.argv.slice(2).filter((arg) => !["--local", "--json"].includes(arg));
const command = args.join(" ");
const tokenPath = join(home, ".routekit-test-tokens.json");
const readTokens = () => existsSync(tokenPath) ? JSON.parse(readFileSync(tokenPath, "utf8")) : [];
const saveTokens = (tokens) => write(tokenPath, JSON.stringify(tokens));
if (command === "status") {
  console.log(JSON.stringify({ daemon: { running: true, healthy: true, dataUrl: process.env.TEST_GATEWAY_URL }, models: { count: 1 } }));
} else if (command === "models list") {
  console.log(JSON.stringify({ models: ["openai/test"] }));
} else if (command === "codex install --no-token") {
  const config = join(home, ".codex", "config.toml");
  const profile = join(home, ".codex", "routekit.config.toml");
  const catalog = join(home, ".codex", ".routekit-model-catalog.json");
  write(config, "# >>> routekit integration >>>\\nbase_url = " + JSON.stringify(process.env.TEST_GATEWAY_URL + "/v1") + "\\n");
  write(catalog, "{}\\n");
  write(profile, 'model = "openai/test"\\nmodel_provider = "routekit"\\nmodel_catalog_json = ' + JSON.stringify(catalog) + "\\n");
} else if (command === "claude install --no-token") {
  const config = join(home, ".claude", "settings.json");
  write(config, JSON.stringify({ env: { ANTHROPIC_BASE_URL: process.env.TEST_GATEWAY_URL } }));
  write(join(home, ".claude", ".routekit-integration.json"), JSON.stringify({ state: "installed", ownerId: "routekit", managedEnvValues: { ANTHROPIC_BASE_URL: process.env.TEST_GATEWAY_URL } }));
} else if (args[0] === "token" && args[1] === "issue") {
  const tokens = readTokens();
  const id = String(tokens.length + 1).repeat(16);
  const createdBy = args[args.indexOf("--created-by") + 1];
  const token = "test-token-" + id;
  tokens.push({ id, token, label: args[2], createdBy, plane: "data", role: "admin" });
  saveTokens(tokens);
  console.log(JSON.stringify({ id, token }));
} else if (command === "token list") {
  console.log(JSON.stringify({ tokens: readTokens().map(({ token: _token, ...entry }) => entry) }));
} else if (args[0] === "token" && args[1] === "revoke") {
  const tokens = readTokens();
  const token = tokens.find((entry) => entry.id === args[2]);
  if (token) token.revokedAt = new Date().toISOString();
  saveTokens(tokens);
  console.log(JSON.stringify({ id: args[2], revoked: true }));
} else {
  console.error("unexpected routekit command: " + command);
  process.exitCode = 1;
}
`
  );
  executable(
    join(bin, "t3"),
    `#!/bin/sh
set -eu
unit="$HOME/.config/systemd/user/t3code.service"
case "$*" in
  --version) echo 't3 v0.0.31' ;;
  'service install') mkdir -p "$(dirname "$unit")"; printf '%s\n' '[Service]' 'ExecStart=/usr/local/bin/t3 service run' >"$unit"; chmod 600 "$unit" ;;
  'service uninstall') rm -f "$unit" ;;
  *) exit 0 ;;
esac
`
  );
  for (const name of ["codex", "claude"]) {
    executable(join(bin, name), `#!/bin/sh\necho '${name} v1.0.0'\n`);
  }
  executable(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n");
  executable(
    join(bin, "tailscale"),
    `#!/bin/sh
if [ "\${FAIL_TAILSCALE:-0}" = 1 ] && [ "\${1:-}" = serve ] && [ "\${2:-}" = --bg ]; then
  echo 'injected Serve failure' >&2
  exit 1
fi
exit 0
`
  );
}

test("deploy parsing selects the intended RouteKit topology for local and remote hosts", () => {
  assert.throws(() => parseDeployArgs([]), /choose --local or --ssh/);
  assert.deepEqual(parseDeployArgs(["--local"]).routekit, {
    kind: "remote",
    name: DEFAULT_ROUTEKIT_REMOTE
  });
  assert.deepEqual(parseDeployArgs(["--ssh", "velum-mini"]).routekit, { kind: "local" });
  assert.throws(
    () => parseDeployArgs(["--local", "--ssh", "velum-mini"]),
    /either --local or --ssh/
  );
  assert.throws(
    () => parseDeployArgs(["--ssh", "velum-mini", "--routekit", "local", "--upgrade-t3"]),
    /requires --yes/
  );
  assert.throws(
    () => parseDeployArgs(["--ssh", "velum-mini", "--routekit", "remote"]),
    /only: local/
  );
  const parsed = parseDeployArgs([
    "--ssh",
    "velum-mini",
    "--routekit-remote",
    "existing-gateway",
    "--project",
    "/Users/alen/src/a",
    "--project",
    "/Users/alen/src/b"
  ]);
  assert.deepEqual(parsed.routekit, { kind: "remote", name: "existing-gateway" });
  assert.equal(parsed.port, DEFAULT_PORT);
  assert.equal(parsed.t3Version, DEFAULT_T3_VERSION);
  assert.equal(DEFAULT_T3_SSH_REMOTE, "velum-mini");
  assert.deepEqual(parsed.projects, ["/Users/alen/src/a", "/Users/alen/src/b"]);
  assert.deepEqual(parseDestroyArgs(["--local"]).local, true);
  assert.throws(() => parseDestroyArgs(["--ssh", "bad host"]), /without whitespace/);
  assert.throws(
    () => parseDeployArgs(["--ssh", "velum-mini", "--headless"]),
    /requires --ssh.*--sudo-user/
  );
  assert.throws(
    () => parseDeployArgs(["--local", "--headless", "--sudo-user", "benjamin"]),
    /requires --ssh.*--sudo-user/
  );
  assert.throws(
    () => parseDeployArgs(["--ssh", "velum-mini", "--sudo-user", "benjamin"]),
    /requires --headless/
  );
  assert.throws(
    () => parseDeployArgs(["--ssh", "velum-mini", "--headless", "--sudo-user", "root"]),
    /non-root local macOS user/
  );
  const linux = parseDeployArgs([
    "--ssh",
    "alice@t3-alen",
    "--service-user",
    "alice",
    "--routekit-remote",
    "gateway-prod"
  ]);
  assert.equal(linux.serviceUser, "alice");
  assert.deepEqual(linux.routekit, { kind: "remote", name: "gateway-prod" });
  assert.throws(() => parseDeployArgs(["--local", "--service-user", "alice"]), /requires --ssh/);
  assert.throws(
    () =>
      parseDeployArgs([
        "--ssh",
        "host",
        "--service-user",
        "alice",
        "--headless",
        "--sudo-user",
        "benjamin"
      ]),
    /cannot be combined/
  );
  assert.equal(
    parseDestroyArgs(["--ssh", "alice@t3-alen", "--service-user", "alice"]).serviceUser,
    "alice"
  );
  assert.equal(assertLinuxServiceUser("alice"), "alice");
  assert.throws(() => assertLinuxServiceUser("root"), /non-root Linux user/);
  const headless = parseDeployArgs([
    "--ssh",
    "root@velum-mini",
    "--headless",
    "--sudo-user",
    "benjamin",
    "--deployment-id",
    "benjamin",
    "--port",
    "3774"
  ]);
  assert.equal(headless.headless, true);
  assert.equal(headless.sudoUser, "benjamin");
  assert.equal(headless.deploymentId, "benjamin");
  assert.equal(headless.port, 3774);
  assert.equal(
    parseDestroyArgs(["--ssh", "root@velum-mini", "--headless", "--sudo-user", "benjamin"])
      .sudoUser,
    "benjamin"
  );
});

test("RouteKit deployment command allowlist excludes all configuration and lifecycle mutations", () => {
  const nonce = "0123456789abcdef01234567";
  const safe = [
    ["--local", "--json", "status"],
    ["--remote", "existing", "codex", "install", "--no-token"],
    [
      "--local",
      "--json",
      "token",
      "issue",
      `t3-routekit-default-${nonce}-codex`,
      "--plane",
      "data",
      "--created-by",
      `t3-routekit:default:${nonce}:codex`
    ],
    ["--remote", "existing", "--json", "token", "revoke", "0011223344556677"]
  ];
  for (const argv of safe) {
    assert.equal(isAllowedRoutekitArgv(argv), true, argv.join(" "));
    assert.deepEqual(assertSafeRoutekitArgv(argv), argv);
  }
  for (const argv of [
    ["config", "init"],
    ["config", "import", "--from", "/tmp/x"],
    ["providers", "add", "openai"],
    ["accounts", "remove", "codex"],
    ["remote", "add", "x"],
    ["codex", "uninstall"],
    ["claude", "uninstall"],
    ["stop"]
  ]) {
    assert.equal(isAllowedRoutekitArgv(argv), false, argv.join(" "));
    assert.throws(() => assertSafeRoutekitArgv(argv), /non-allowlisted RouteKit operation/);
  }
  assert.equal(
    isAllowedRoutekitArgv(["--local", "token", "issue", "user-token", "--plane", "data"]),
    false,
    "the helper may issue only nonce-owned deployment tokens"
  );
  assert.equal(isAllowedRoutekitArgv(["--local", "daemon", "reload"]), false);
  assert.deepEqual(routekitTargetArgs({ kind: "local" }), ["--local"]);
  assert.deepEqual(routekitTargetArgs({ kind: "remote", name: "existing" }), [
    "--remote",
    "existing"
  ]);
});

test("wrapper keeps raw credentials in Keychain and forces T3's Codex app-server onto the RouteKit profile", () => {
  const names = deploymentNames();
  const nonce = "0123456789abcdef01234567";
  const wrapper = buildWrapper({
    t3Path: "/opt/homebrew/bin/t3",
    nodePath: "/Users/alen/.nvm/versions/node/v24.17.0/bin/node",
    codexPath: "/opt/homebrew/bin/codex",
    claudePath: "/opt/homebrew/bin/claude",
    codexAccount: `t3-routekit-${names.id}.${nonce}.codex`,
    claudeAccount: `t3-routekit-${names.id}.${nonce}.claude`,
    codexLaunchArgs:
      '-c model="openai/gpt-5.5" -c model_provider="routekit" -c model_catalog_json="/Users/alen/.codex/.routekit-model-catalog.json"',
    claudeBaseUrl: "http://127.0.0.1:8080",
    baseDir: "/Users/alen/.t3",
    home: "/Users/alen",
    port: DEFAULT_PORT
  });
  assert.match(wrapper, /security find-generic-password/);
  assert.match(wrapper, /export HOME='\/Users\/alen'/);
  assert.match(wrapper, /T3CODE_CODEX_LAUNCH_ARGS/);
  assert.match(wrapper, /model_provider=/);
  assert.match(wrapper, /ANTHROPIC_BASE_URL/);
  assert.match(wrapper, /launchctl setenv ROUTEKIT_GATEWAY_TOKEN/);
  assert.match(wrapper, /launchctl setenv ANTHROPIC_AUTH_TOKEN/);
  assert.doesNotMatch(wrapper, /rk1_[A-Za-z0-9_-]{8,}/);
  assert.doesNotMatch(wrapper, /ROUTEKIT_GATEWAY_TOKEN='[^']+'/);
  assert.doesNotMatch(wrapper, /ANTHROPIC_AUTH_TOKEN='[^']+'/);
  assert.equal(sha256(wrapper).length, 64);
});

test("SSH-launched T3 reads deployment credentials from the GUI launchd domain", () => {
  const shim = buildT3SshShim({
    entryPath: "/opt/homebrew/lib/node_modules/t3/dist/bin.mjs"
  });
  assert.equal(DEPLOYMENT_VERSION, 5);
  assert.match(shim, /launchctl print "gui\/\$\(\/usr\/bin\/id -u\)"/);
  assert.match(shim, /ROUTEKIT_GATEWAY_TOKEN/);
  assert.match(shim, /ANTHROPIC_AUTH_TOKEN/);
  assert.match(shim, /ANTHROPIC_BASE_URL/);
  assert.match(shim, /exec '\/opt\/homebrew\/lib\/node_modules\/t3\/dist\/bin\.mjs' "\$@"/);
  assert.doesNotMatch(shim, /rk1_[A-Za-z0-9_-]{8,}/);
  assert.throws(() => buildT3SshShim({ entryPath: "relative/t3" }), /must be an absolute/);
});

test("headless wrappers read only user-owned credential files", () => {
  const common = {
    t3Path: "/Users/benjamin/.local/bin/t3",
    nodePath: "/opt/homebrew/bin/node",
    codexPath: "/Users/benjamin/.local/bin/codex",
    claudePath: "/Users/benjamin/.local/bin/claude",
    codexTokenPath: "/Users/benjamin/.routekit/t3/benjamin/credentials/codex-token",
    claudeTokenPath: "/Users/benjamin/.routekit/t3/benjamin/credentials/claude-token",
    codexLaunchArgs: '-c model_provider="routekit"',
    claudeBaseUrl: "http://127.0.0.1:8080",
    baseDir: "/Users/benjamin/.t3",
    home: "/Users/benjamin",
    port: 3774
  };
  const wrapper = buildHeadlessWrapper(common);
  assert.match(wrapper, /credentials\/codex-token/);
  assert.match(wrapper, /credentials\/claude-token/);
  assert.doesNotMatch(wrapper, /security find-generic-password/);
  assert.doesNotMatch(wrapper, /launchctl setenv/);
  assert.doesNotMatch(wrapper, /rk1_[A-Za-z0-9_-]{8,}/);

  const shim = buildHeadlessT3SshShim({
    ...common,
    entryPath: "/Users/benjamin/.local/lib/node_modules/t3/dist/bin.mjs"
  });
  assert.match(shim, /credentials\/codex-token/);
  assert.match(shim, /ANTHROPIC_BASE_URL/);
  assert.match(shim, /T3CODE_CODEX_LAUNCH_ARGS/);
  assert.doesNotMatch(shim, /launchctl print "gui/);
});

test("LaunchAgent is narrowly named and references only deployment-owned paths", () => {
  const names = deploymentNames("default");
  const plist = buildLaunchAgentPlist({
    label: names.label,
    wrapperPath: "/Users/alen/.routekit/t3/default/run-t3.sh",
    stdoutPath: "/Users/alen/.routekit/t3/default/logs/t3.stdout.log",
    stderrPath: "/Users/alen/.routekit/t3/default/logs/t3.stderr.log",
    workingDirectory: "/Users/alen/.routekit/t3/default"
  });
  assert.match(plist, /com\.velum\.routekit\.t3\.default/);
  assert.match(plist, /RunAtLoad/);
  assert.match(plist, /KeepAlive/);
  assert.doesNotMatch(plist, /\.t3\/userdata/);
  assert.throws(
    () =>
      buildLaunchAgentPlist({
        label: "com.example.other",
        wrapperPath: "/tmp/x",
        stdoutPath: "/tmp/out",
        stderrPath: "/tmp/err",
        workingDirectory: "/tmp"
      }),
    /not RouteKit T3-owned/
  );
});

test("LaunchDaemon runs as the target user and contains no credentials", () => {
  const plist = buildLaunchDaemonPlist({
    label: deploymentNames("benjamin").label,
    userName: "benjamin",
    home: "/Users/benjamin",
    wrapperPath: "/Users/benjamin/.routekit/t3/benjamin/run-t3.sh",
    stdoutPath: "/Users/benjamin/.routekit/t3/benjamin/logs/t3.stdout.log",
    stderrPath: "/Users/benjamin/.routekit/t3/benjamin/logs/t3.stderr.log",
    workingDirectory: "/Users/benjamin/.routekit/t3/benjamin"
  });
  assert.match(plist, /<key>UserName<\/key>\s*<string>benjamin<\/string>/);
  assert.match(plist, /<key>HOME<\/key>\s*<string>\/Users\/benjamin<\/string>/);
  assert.match(plist, /RunAtLoad/);
  assert.match(plist, /KeepAlive/);
  assert.doesNotMatch(plist, /ROUTEKIT_GATEWAY_TOKEN|ANTHROPIC_AUTH_TOKEN|rk1_/);
});

test("Linux uses a token-free systemd drop-in that references only a private environment file", () => {
  const dropIn = buildSystemdDropIn("/home/alice/.routekit/t3/default/t3.env");
  assert.equal(dropIn, "[Service]\nEnvironmentFile=/home/alice/.routekit/t3/default/t3.env\n");
  assert.doesNotMatch(dropIn, /ROUTEKIT_GATEWAY_TOKEN|ANTHROPIC_AUTH_TOKEN|rk1_/);
  assert.throws(() => buildSystemdDropIn("relative.env"), /absolute path/);

  const helper = readFileSync(join(root, "scripts/lib/t3-routekit-linux-remote.mjs"), "utf8");
  assert.match(helper, /t3Path, \["service", "install"\]/);
  assert.match(helper, /XDG_RUNTIME_DIR/);
  assert.match(helper, /DBUS_SESSION_BUS_ADDRESS/);
  assert.match(helper, /\[ "\$#" -eq 1 \] && \[ "\$1" = "enable-linger" \]/);
  assert.match(helper, /show-user \$\{serviceUser\} --property=Linger --value/);
  assert.match(helper, /rmdirSync\(paths\.lingerShimDir\)/);
  const entrypoint = readFileSync(join(root, "scripts/t3-routekit-deploy.mjs"), "utf8");
  assert.match(entrypoint, /loginctl enable-linger/);
  assert.match(entrypoint, /passwordless sudo/);
  assert.match(helper, /chmodSync\(path, 0o600\)/);
  assert.match(helper, /EnvironmentFile=/);
  assert.match(helper, /refusing non-allowlisted RouteKit operation/);
  assert.match(helper, /rollback\(paths, manifest\)/);
  assert.match(helper, /manifest-owned T3 systemd unit was modified/);
  assert.doesNotMatch(helper, /assets:\s*\{[^}]*ROUTEKIT_GATEWAY_TOKEN/s);
});

test("Linux dry-run resolves the native service prerequisites without writing user state", () => {
  const fixture = mkdtempSync(join(tmpdir(), "routekit-t3-linux-dry-run-"));
  try {
    const home = join(fixture, "home");
    const bin = join(fixture, "bin");
    execFileSync("mkdir", ["-p", home, bin]);
    writeFileSync(
      join(bin, "routekit"),
      `#!/bin/sh\ncase " $* " in\n  *" status "*) printf '%s\\n' '{"daemon":{"running":true,"healthy":true,"dataUrl":"http://127.0.0.1:8080"},"models":{"count":2}}' ;;\n  *" remote list "*) printf '%s\\n' '{"remotes":[{"name":"gateway-prod","gatewayUrl":"https://gateway.example.test","token":"stored"}]}' ;;\n  *) printf '%s\\n' '{"models":["codex/a","claude/b"]}' ;;\nesac\n`,
      { mode: 0o700 }
    );
    for (const name of ["t3", "codex", "claude"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${name} v0.0.31'\n`, {
        mode: 0o700
      });
    }
    const helper = readFileSync(join(root, "scripts/lib/t3-routekit-linux-remote.mjs"), "utf8");
    const payload = Buffer.from(
      JSON.stringify({
        action: "deploy",
        deploymentId: "default",
        routekit: { kind: "local" },
        port: 3773,
        t3Version: "0.0.31",
        projects: [],
        dryRun: true
      })
    ).toString("base64url");
    const output = execFileSync(process.execPath, ["--input-type=module", "-", payload], {
      input: `Object.defineProperty(process, "platform", { value: "linux" });\n${helper}`,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8"
    });
    const result = JSON.parse(output);
    assert.equal(result.ok, true);
    assert.equal(result.action, "would-deploy");
    assert.equal(result.serviceMode, "systemd-user");
    assert.equal(existsSync(join(home, ".routekit")), false);
    assert.equal(existsSync(join(home, ".t3")), false);

    const remotePayload = Buffer.from(
      JSON.stringify({
        action: "deploy",
        deploymentId: "default",
        routekit: { kind: "remote", name: "gateway-prod" },
        port: 3773,
        t3Version: "0.0.31",
        projects: [],
        dryRun: true
      })
    ).toString("base64url");
    const remoteOutput = execFileSync(
      process.execPath,
      ["--input-type=module", "-", remotePayload],
      {
        input: `Object.defineProperty(process, "platform", { value: "linux" });\n${helper}`,
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
        encoding: "utf8"
      }
    );
    assert.equal(JSON.parse(remoteOutput).action, "would-deploy");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Linux deploy is private and idempotent, destruction is guarded, and rollback is recoverable", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "routekit-t3-linux-lifecycle-"));
  try {
    const home = join(fixture, "home");
    const bin = join(fixture, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(home, "project-state.txt"), "preserve me\n");
    installLinuxFixtureCommands(bin);
    const helper = readFileSync(join(root, "scripts/lib/t3-routekit-linux-remote.mjs"), "utf8");
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_FAKE_HTTP: "1",
      TEST_GATEWAY_URL: "http://127.0.0.1:48888"
    };
    const deployPayload = {
      action: "deploy",
      deploymentId: "default",
      routekit: { kind: "local" },
      port: 3773,
      t3Version: "0.0.31",
      projects: [],
      dryRun: false
    };
    const destroyPayload = { action: "destroy", deploymentId: "default", dryRun: false };

    const deployed = await runLinuxHelper(helper, deployPayload, env);
    assert.equal(deployed.result.ok, true, deployed.result.error);
    assert.equal(deployed.result.action, "deployed");
    const envPath = join(home, ".routekit", "t3", "default", "t3.env");
    const dropInPath = join(
      home,
      ".config",
      "systemd",
      "user",
      "t3code.service.d",
      "routekit.conf"
    );
    const unitPath = join(home, ".config", "systemd", "user", "t3code.service");
    const originalEnvironment = readFileSync(envPath, "utf8");
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    assert.equal(statSync(dropInPath).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(dropInPath, "utf8"), /test-token|AUTH_TOKEN/);
    assert.doesNotMatch(readFileSync(unitPath, "utf8"), /test-token|AUTH_TOKEN/);

    const repeated = await runLinuxHelper(helper, deployPayload, env);
    assert.equal(repeated.result.ok, true, repeated.result.error);
    assert.equal(repeated.result.action, "verified-existing");

    writeFileSync(envPath, `${originalEnvironment}USER_EDIT=1\n`, { mode: 0o600 });
    const guarded = await runLinuxHelper(helper, destroyPayload, env);
    assert.equal(guarded.result.ok, false);
    assert.match(guarded.result.error, /environment was modified/);
    assert.equal(existsSync(unitPath), true);

    writeFileSync(envPath, originalEnvironment, { mode: 0o600 });
    const destroyed = await runLinuxHelper(helper, destroyPayload, env);
    assert.equal(destroyed.result.ok, true, destroyed.result.error);
    assert.equal(destroyed.result.action, "destroyed");
    assert.equal(existsSync(envPath), false);
    assert.equal(existsSync(dropInPath), false);
    assert.equal(existsSync(unitPath), false);
    assert.equal(readFileSync(join(home, "project-state.txt"), "utf8"), "preserve me\n");

    const failed = await runLinuxHelper(helper, deployPayload, { ...env, FAIL_TAILSCALE: "1" });
    assert.equal(failed.result.ok, false);
    assert.match(failed.result.error, /injected Serve failure/);
    assert.equal(existsSync(envPath), false);
    assert.equal(existsSync(unitPath), false);
    const tokens = JSON.parse(readFileSync(join(home, ".routekit-test-tokens.json"), "utf8"));
    assert.equal(tokens.slice(-2).every((token) => typeof token.revokedAt === "string"), true);

    const retried = await runLinuxHelper(helper, deployPayload, env);
    assert.equal(retried.result.ok, true, retried.result.error);
    assert.equal(retried.result.action, "deployed");
    const recovered = await runLinuxHelper(helper, destroyPayload, env);
    assert.equal(recovered.result.ok, true, recovered.result.error);
    assert.equal(recovered.result.action, "destroyed");
    assert.equal(readFileSync(join(home, "project-state.txt"), "utf8"), "preserve me\n");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the remote helper refuses token adoption and Keychain overwrite paths", () => {
  const helper = readFileSync(join(root, "scripts/lib/t3-routekit-remote.mjs"), "utf8");
  assert.match(helper, /refusing non-allowlisted RouteKit operation/);
  assert.match(helper, /found multiple RouteKit tokens with deployment ownership proof/);
  assert.match(helper, /record\.id !== "0000000000000000" && entry\.id !== record\.id/);
  assert.match(helper, /security add-generic-password/);
  assert.doesNotMatch(helper, /add-generic-password[^\n]* -U(?:\s|$)/);
  assert.match(helper, /keychainDeleteVerified/);
  assert.match(helper, /sha256\(stored\) !== record\.tokenSha256/);
  assert.match(helper, /refusing non-directory or symlinked/);
  assert.match(helper, /requireRegular\(path, "native integration registry"\)/);
  assert.match(helper, /untracked RouteKit .* ownership files without a complete integration/);
  assert.match(helper, /command\.length === 7/);
  assert.match(helper, /isDeploymentTokenPair\(command\[2\], command\[6\]\)/);
  assert.match(helper, /which t3 failed/);
  assert.match(helper, /t3Home: join\(home, "\.t3"\)/);
  assert.match(helper, /stopDefaultT3Listeners/);
  assert.match(helper, /planT3SshShim/);
  assert.match(helper, /installT3SshShim/);
  assert.match(helper, /restoreT3SshShim/);
  assert.match(helper, /T3 SSH launcher shim/);
  assert.match(helper, /commandPath\("t3", \{ resolveSymlink: false \}\)/);
  assert.match(helper, /headless deployment must run through passwordless sudo as root/);
  assert.match(helper, /uid: asDeploymentUser \? executionContext\.uid/);
  assert.match(helper, /\/Library\/LaunchDaemons/);
  assert.match(helper, /deployment credential file has unsafe ownership or permissions/);
  assert.match(helper, /chownSync\(paths\.plistPath, 0, 0\)/);
  assert.match(helper, /refusing a non-directory or symlinked user path/);
  assert.match(helper, /headless deployment requires a per-user T3 executable/);
  assert.doesNotMatch(helper, /removeLegacyT3Configuration/);
});

test("a partial RouteKit client integration fails before deployment state or native configuration changes", () => {
  const fixture = mkdtempSync(join(tmpdir(), "routekit-t3-partial-integration-"));
  try {
    const home = join(fixture, "home");
    const state = join(fixture, "state");
    const bin = join(fixture, "bin");
    const transcript = join(fixture, "routekit.log");
    const helper = readFileSync(join(root, "scripts/lib/t3-routekit-remote.mjs"), "utf8");
    execFileSync("mkdir", ["-p", join(home, ".codex"), bin]);
    // This is deliberately incomplete: a past/manual RouteKit attempt left a
    // profile without the owned config block. The deployer must not ask the
    // installer to recover it, because that could overwrite the profile.
    writeFileSync(join(home, ".codex", "routekit.config.toml"), 'model = "user-model"\n');
    const command = join(bin, "routekit");
    writeFileSync(
      command,
      `#!/bin/sh\nprintf '%s\\n' "$*" >>${JSON.stringify(transcript)}\nprintf '%s\\n' '{"daemon":{"running":true,"healthy":true,"dataUrl":"http://127.0.0.1:8080"},"models":{"count":1}}'\n`,
      { mode: 0o700 }
    );
    for (const name of ["t3", "codex", "claude"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho '${name} v0.0.31'\n`, { mode: 0o700 });
    }
    const payload = Buffer.from(
      JSON.stringify({
        action: "deploy",
        deploymentId: "default",
        routekit: { kind: "local" },
        port: 3774,
        t3Version: "0.0.31",
        projects: []
      })
    ).toString("base64url");
    const output = execFileSync(process.execPath, ["--input-type=module", "-", payload], {
      input: `Object.defineProperty(process, "platform", { value: "darwin" });\n${helper}`,
      env: { ...process.env, HOME: home, ROUTEKIT_HOME: state, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8"
    });
    const result = JSON.parse(output);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /untracked RouteKit codex ownership files/);
    assert.equal(existsSync(join(state, "t3", "deployments", "default.json")), false);
    assert.equal(
      readFileSync(join(home, ".codex", "routekit.config.toml"), "utf8"),
      'model = "user-model"\n'
    );
    assert.doesNotMatch(readFileSync(transcript, "utf8"), /codex install/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the SSH entrypoint streams a self-contained helper and rejects a malformed remote result", () => {
  const fixture = mkdtempSync(join(tmpdir(), "routekit-t3-deploy-test-"));
  try {
    const bin = join(fixture, "bin");
    const log = join(fixture, "ssh.log");
    const argsLog = join(fixture, "ssh-args.log");
    execFileSync("mkdir", ["-p", bin]);
    const ssh = join(bin, "ssh");
    writeFileSync(
      ssh,
      `#!/bin/sh\nlast=''\nfor value in "$@"; do last=$value; done\nif [ "$last" = 'uname -s' ]; then printf '%s\\n' "\${SSH_PLATFORM:-Darwin}"; exit 0; fi\nprintf '%s\\n' "$@" >${JSON.stringify(argsLog)}\ncat >${JSON.stringify(log)}\nprintf '%s\\n' '{"ok":true,"action":"would-deploy"}'\n`,
      { mode: 0o700 }
    );
    chmodSync(ssh, 0o700);
    const output = execFileSync(
      process.execPath,
      ["scripts/t3-routekit-deploy.mjs", "--ssh", "velum-mini", "--routekit", "local", "--dry-run"],
      { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" }
    );
    assert.match(output, /would-deploy/);
    const helper = readFileSync(log, "utf8");
    assert.match(helper, /This program is streamed over SSH/);
    assert.match(helper, /--no-token/);
    // The helper carries no command that can delete a native integration or
    // invoke RouteKit's destructive configuration/lifecycle actions.
    assert.doesNotMatch(
      helper,
      /routekit\s+(?:--\w+\s+)*(?:config init|config import)/
    );
    assert.doesNotMatch(helper, /routekit\s+(?:--\w+\s+)*(?:codex|claude) uninstall/);

    execFileSync(
      process.execPath,
      [
        "scripts/t3-routekit-deploy.mjs",
        "--ssh",
        "root@velum-mini",
        "--routekit",
        "local",
        "--headless",
        "--sudo-user",
        "benjamin",
        "--dry-run"
      ],
      { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" }
    );
    const sshArgs = readFileSync(argsLog, "utf8");
    assert.match(sshArgs, /root@velum-mini/);
    assert.match(sshArgs, /\/usr\/bin\/sudo/);
    assert.match(sshArgs, /PATH=\/opt\/homebrew\/bin:/);

    execFileSync(
      process.execPath,
      [
        "scripts/t3-routekit-deploy.mjs",
        "--ssh",
        "alice@t3-alen",
        "--service-user",
        "alice",
        "--routekit-remote",
        "gateway-prod",
        "--dry-run"
      ],
      {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SSH_PLATFORM: "Linux" },
        encoding: "utf8"
      }
    );
    const linuxHelper = readFileSync(log, "utf8");
    assert.match(linuxHelper, /Self-contained Linux helper streamed over SSH/);
    assert.match(linuxHelper, /EnvironmentFile=/);
    const linuxArgs = readFileSync(argsLog, "utf8");
    assert.match(linuxArgs, /\/usr\/bin\/sudo/);
    assert.match(linuxArgs, /-u\nalice/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
