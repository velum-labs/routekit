import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  assertSafeRoutekitArgv,
  buildLaunchAgentPlist,
  buildWrapper,
  DEFAULT_PORT,
  DEFAULT_ROUTEKIT_REMOTE,
  DEFAULT_T3_SSH_REMOTE,
  DEFAULT_T3_VERSION,
  deploymentNames,
  isAllowedRoutekitArgv,
  parseDeployArgs,
  parseDestroyArgs,
  routekitTargetArgs,
  sha256
} from "../lib/t3-routekit-deployment.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);

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
      '-c model="openai/gpt-5.6-sol" -c model_provider="routekit" -c model_catalog_json="/Users/alen/.codex/.routekit-model-catalog.json"',
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
    execFileSync("mkdir", ["-p", bin]);
    const ssh = join(bin, "ssh");
    writeFileSync(
      ssh,
      `#!/bin/sh\ncat >${JSON.stringify(log)}\nprintf '%s\\n' '{"ok":true,"action":"would-deploy"}'\n`,
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
      /routekit\s+(?:--\w+\s+)*(?:config init|config import|config migrate)/
    );
    assert.doesNotMatch(helper, /routekit\s+(?:--\w+\s+)*(?:codex|claude) uninstall/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
