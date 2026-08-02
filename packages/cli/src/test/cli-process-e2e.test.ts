import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runCli(
  args: readonly string[],
  input: { cwd: string; env: NodeJS.ProcessEnv }
): CliResult {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: input.cwd,
    env: input.env,
    encoding: "utf8",
    timeout: 30_000
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

function mustRun(args: readonly string[], input: { cwd: string; env: NodeJS.ProcessEnv }): string {
  const result = runCli(args, input);
  assert.equal(
    result.status,
    0,
    `routekit ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`
  );
  return result.stdout;
}

test("real routekit command surfaces execute independently", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-command-process-"));
  const project = join(root, "project");
  const stateHome = join(root, "state");
  const home = join(root, "home");
  mkdirSync(join(project, ".routekit"), { recursive: true });
  mkdirSync(home);
  const configPath = join(project, ".routekit", "router.yaml");
  writeFileSync(
    configPath,
    ["providers:", "  openai: {}", "defaultModel: openai/command-model", ""].join("\n")
  );
  const env = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    ROUTEKIT_TELEMETRY: "0",
    PORTLESS: "0",
    NO_COLOR: "1"
  };
  const input = { cwd: project, env };
  try {
    const version = JSON.parse(mustRun(["version", "--json"], input)) as {
      package?: string;
      version?: string;
    };
    assert.equal(version.package, "@velum-labs/routekit");
    assert.match(version.version ?? "", /^\d+\.\d+\.\d+/);

    for (const shell of ["bash", "zsh", "fish"]) {
      assert.match(mustRun(["completion", shell], input), /routekit/);
    }

    const installHelp = runCli(["codex", "install", "--help"], input);
    assert.equal(installHelp.status, 0, installHelp.stderr);
    assert.match(installHelp.stdout, /--codex-home/);
    assert.match(installHelp.stdout, /--rotate-token/);
    assert.match(installHelp.stdout, /--no-token/);
    assert.doesNotMatch(installHelp.stdout, /--gateway-url/);

    const claudeInstallHelp = runCli(["claude", "install", "--help"], input);
    assert.equal(claudeInstallHelp.status, 0, claudeInstallHelp.stderr);
    assert.match(claudeInstallHelp.stdout, /--claude-config-dir/);
    assert.match(claudeInstallHelp.stdout, /--rotate-token/);
    assert.match(claudeInstallHelp.stdout, /--no-token/);
    assert.doesNotMatch(claudeInstallHelp.stdout, /--gateway-url/);

    const legacyInstall = runCli(["install", "codex"], input);
    assert.equal(legacyInstall.status, 1);
    assert.match(legacyInstall.stderr, /unknown command/i);

    const setupHelp = runCli(["setup", "--help"], input);
    assert.equal(setupHelp.status, 0, setupHelp.stderr);
    assert.match(setupHelp.stdout, /--no-browser/);

    for (const fusionOnly of ["prompts", "ensemble"]) {
      const rejected = runCli([fusionOnly], input);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /unknown command/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config init does not install a crash-looping daemon when credentials are missing", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-init-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const stateHome = join(root, "state");
  mkdirSync(home);
  mkdirSync(project);
  const env = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    ROUTEKIT_NO_SUPERVISOR: "1",
    PORTLESS: "0",
    NO_COLOR: "1",
    OPENAI_API_KEY: undefined
  };
  try {
    const result = runCli(["config", "init", "--global", "--json"], {
      cwd: project,
      env
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      created?: boolean;
      daemonStarted?: boolean;
      missingCredentials?: string[];
    };
    assert.equal(payload.created, true);
    assert.equal(payload.daemonStarted, false);
    assert.deepEqual(payload.missingCredentials, ["OPENAI_API_KEY"]);
    assert.equal(existsSync(join(home, ".config", "routekit", "router.yaml")), true);
    assert.equal(existsSync(join(stateHome, "services", "daemon.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config init supports API provider starters and empty subscription bootstrap", () => {
  const cases = [
    {
      name: "anthropic",
      args: ["--provider", "anthropic"],
      providers: ["anthropic"],
      defaultModel: "anthropic/claude-sonnet-4-5",
      missing: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
    },
    {
      name: "openrouter",
      args: ["--provider", "openrouter"],
      providers: ["openrouter"],
      defaultModel: "openrouter/anthropic/claude-sonnet-4.5",
      missing: ["OPENROUTER_API_KEY"]
    },
    {
      name: "bedrock",
      args: ["--provider", "bedrock", "--default-model", "bedrock/us.anthropic.claude-sonnet"],
      providers: ["bedrock"],
      defaultModel: "bedrock/us.anthropic.claude-sonnet",
      missing: []
    }
  ] as const;
  for (const fixture of cases) {
    const root = mkdtempSync(join(tmpdir(), `routekit-config-init-${fixture.name}-`));
    const home = join(root, "home");
    const project = join(root, "project");
    const stateHome = join(root, "state");
    mkdirSync(home);
    mkdirSync(project);
    const env = {
      ...process.env,
      HOME: home,
      ROUTEKIT_HOME: stateHome,
      ROUTEKIT_NO_SUPERVISOR: "1",
      ROUTEKIT_DAEMON_PORT: "0",
      ROUTEKIT_TELEMETRY: "0",
      PORTLESS: "0",
      NO_COLOR: "1",
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      OPENROUTER_API_KEY: undefined,
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
      AWS_PROFILE: undefined,
      AWS_REGION: undefined,
      AWS_DEFAULT_REGION: undefined,
      AWS_EC2_METADATA_DISABLED: "true"
    };
    try {
      const result = runCli(["config", "init", "--global", ...fixture.args, "--json"], {
        cwd: project,
        env
      });
      if (fixture.name === "bedrock") {
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(join(home, ".config", "routekit", "router.yaml")), true);
      } else {
        assert.equal(result.status, 0, result.stderr);
        const payload = JSON.parse(result.stdout) as {
          providers?: string[];
          defaultModel?: string;
          missingCredentials?: string[];
          daemonStarted?: boolean;
        };
        assert.deepEqual(payload.providers, fixture.providers);
        assert.equal(payload.defaultModel, fixture.defaultModel);
        assert.deepEqual(payload.missingCredentials, fixture.missing);
        assert.equal(payload.daemonStarted, false);
      }
      const config = parseYaml(
        readFileSync(join(home, ".config", "routekit", "router.yaml"), "utf8")
      ) as {
        providers: Record<string, unknown>;
        defaultModel?: string;
      };
      assert.deepEqual(Object.keys(config.providers), fixture.providers);
      assert.equal(config.defaultModel, fixture.defaultModel);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const root = mkdtempSync(join(tmpdir(), "routekit-config-init-empty-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const stateHome = join(root, "state");
  mkdirSync(home);
  mkdirSync(project);
  const input = {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      ROUTEKIT_HOME: stateHome,
      ROUTEKIT_NO_SUPERVISOR: "1",
      ROUTEKIT_DAEMON_PORT: "0",
      ROUTEKIT_TELEMETRY: "0",
      PORTLESS: "0",
      NO_COLOR: "1"
    }
  };
  try {
    const result = runCli(["config", "init", "--global", "--empty", "--json"], input);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      providers?: string[];
      daemonStarted?: boolean;
    };
    assert.deepEqual(payload.providers, []);
    assert.equal(payload.daemonStarted, true);
    const stopped = runCli(["stop", "--json"], input);
    assert.equal(stopped.status, 0, stopped.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config init validates option combinations and Bedrock defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-init-options-"));
  const home = join(root, "home");
  mkdirSync(home);
  const input = {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      ROUTEKIT_HOME: join(root, "state"),
      PORTLESS: "0",
      NO_COLOR: "1"
    }
  };
  try {
    const bedrock = runCli(["config", "init", "--provider", "bedrock"], input);
    assert.equal(bedrock.status, 1);
    assert.match(bedrock.stderr, /requires.*--default-model/i);

    const wrongNamespace = runCli(
      ["config", "init", "--provider", "anthropic", "--default-model", "openai/gpt-5.5"],
      input
    );
    assert.equal(wrongNamespace.status, 1);
    assert.match(wrongNamespace.stderr, /does not belong to provider/);

    const defaultWithoutProvider = runCli(
      ["config", "init", "--default-model", "openai/gpt-5.5"],
      input
    );
    assert.equal(defaultWithoutProvider.status, 1);
    assert.match(defaultWithoutProvider.stderr, /requires --provider/);

    const conflict = runCli(["config", "init", "--empty", "--provider", "openai"], input);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /cannot be used with option/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup rejects machine modes and remote targeting", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-setup-modes-"));
  const input = {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      ROUTEKIT_HOME: join(root, "state"),
      PORTLESS: "0",
      NO_COLOR: "1"
    }
  };
  try {
    for (const args of [
      ["setup", "--json"],
      ["setup", "--no-input"]
    ]) {
      const result = runCli(args, input);
      assert.equal(result.status, 1);
      assert.match(`${result.stdout}\n${result.stderr}`, /interactive and does not support/);
    }
    const remote = runCli(["--remote", "missing", "setup"], input);
    assert.equal(remote.status, 1);
    assert.match(remote.stderr, /local-only/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config migrate diagnoses and converts legacy endpoint config explicitly", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-migrate-command-"));
  const configPath = join(root, "router.yaml");
  writeFileSync(
    configPath,
    [
      "endpoints:",
      "  - endpointId: kimi",
      "    model: moonshotai/kimi-k2-thinking",
      "    provider: openrouter",
      "    baseUrl: https://openrouter.ai/api/v1",
      "    apiKeyEnv: OPENROUTER_API_KEY",
      "defaultEndpointId: kimi",
      ""
    ].join("\n")
  );
  const input = {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      ROUTEKIT_HOME: join(root, "state"),
      PORTLESS: "0",
      NO_COLOR: "1"
    }
  };
  try {
    const preview = JSON.parse(
      mustRun(["--config", configPath, "config", "migrate", "--dry-run", "--json"], input)
    ) as {
      migration?: {
        changed?: boolean;
        diagnostics?: Array<{ code?: string }>;
      };
    };
    assert.equal(preview.migration?.changed, true);
    assert.equal(
      preview.migration?.diagnostics?.some((diagnostic) => diagnostic.code === "custom-alias"),
      true
    );
    assert.match(readFileSync(configPath, "utf8"), /^endpoints:/);

    mustRun(["config", "migrate", "--json"], {
      ...input,
      env: { ...input.env, ROUTEKIT_CONFIG: configPath }
    });
    const migrated = readFileSync(configPath, "utf8");
    assert.match(migrated, /^providers:/);
    assert.match(migrated, /defaultModel: openrouter\/moonshotai\/kimi-k2-thinking/);
    assert.doesNotMatch(migrated, /endpoints:|defaultEndpointId:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
