import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseRouterConfig, type RouterConfig } from "@velum-labs/routekit-config";
import { SERVICE_UNSET_ENV } from "@velum-labs/routekit-runtime/environment";

import { daemonServeArgs } from "../client.js";
import { drainGraceMs } from "../commands/serve-options.js";
import { argsWithPort } from "../effect/commands/upgrade.js";
import {
  daemonUnitSpec,
  missingServiceCredentialVariables,
  serviceEnvironment,
  serviceEnvironmentContractInstalled
} from "../daemon.js";

test("daemon service units use stable RouteKit state as their working directory", () => {
  const previous = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = "/tmp/routekit-stable-home";
  try {
    const spec = daemonUnitSpec({
      args: ["daemon", "run"],
      supervisor: "launchd",
      env: { set: {}, unset: [] },
      drainGraceMs: 30_000
    });
    assert.equal(spec.workingDirectory, "/tmp/routekit-stable-home");
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
  }
});

test("daemon services capture only configured direct-provider credentials", () => {
  const config = parseRouterConfig({
    providers: { openai: {} },
    defaultModel: "openai/test-model"
  });
  const environment = serviceEnvironment(config, {
    OPENAI_API_KEY: "configured-secret",
    ANTHROPIC_API_KEY: "unrelated-secret"
  });
  assert.equal(environment.set.OPENAI_API_KEY, "configured-secret");
  assert.equal(environment.set.OPENAI_BASE_URL, "https://api.openai.com");
  assert.equal(environment.set.ANTHROPIC_API_KEY, undefined);
  assert.equal(environment.unset.includes("ANTHROPIC_API_KEY"), false);
  assert.deepEqual(missingServiceCredentialVariables(config, {}), ["OPENAI_API_KEY"]);
});

test("direct Anthropic pins its endpoint and removes the native auth-token alternative", () => {
  const config = parseRouterConfig({
    providers: { anthropic: {} },
    defaultModel: "anthropic/test-model"
  });
  const defaults = serviceEnvironment(config, {
    ANTHROPIC_API_KEY: "direct-key",
    ANTHROPIC_AUTH_TOKEN: "native-client-token"
  });
  assert.deepEqual(defaults.set, {
    ANTHROPIC_API_KEY: "direct-key",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com"
  });
  assert.deepEqual(defaults.unset, ["ANTHROPIC_AUTH_TOKEN"]);

  const custom = serviceEnvironment(config, {
    ANTHROPIC_API_KEY: "direct-key",
    ANTHROPIC_BASE_URL: "https://anthropic.example",
    ANTHROPIC_AUTH_TOKEN: "native-client-token"
  });
  assert.equal(custom.set.ANTHROPIC_BASE_URL, "https://anthropic.example");

  const empty = serviceEnvironment(config, {
    ANTHROPIC_API_KEY: "direct-key",
    ANTHROPIC_BASE_URL: "   "
  });
  assert.equal(empty.set.ANTHROPIC_BASE_URL, "https://api.anthropic.com");
  assert.deepEqual(
    missingServiceCredentialVariables(config, {
      ANTHROPIC_AUTH_TOKEN: "not-a-direct-key"
    }),
    ["ANTHROPIC_API_KEY"]
  );
});

test("subscription providers remove native overrides without copying client credentials", () => {
  const claude = serviceEnvironment(parseRouterConfig({ providers: { "claude-code": {} } }), {
    ANTHROPIC_API_KEY: "client-api-key",
    ANTHROPIC_AUTH_TOKEN: "client-token",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8080"
  });
  assert.deepEqual(claude.set, {});
  assert.deepEqual(claude.unset, [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL"
  ]);

  const codex = serviceEnvironment(parseRouterConfig({ providers: { codex: {} } }), {
    CODEX_API_KEY: "client-codex-key",
    CODEX_RESPONSES_BASE_URL: "http://127.0.0.1:8080/v1",
    OPENAI_API_KEY: "client-openai-key",
    OPENAI_BASE_URL: "http://127.0.0.1:8080/v1"
  });
  assert.deepEqual(codex.set, {});
  assert.deepEqual(codex.unset, [
    "CODEX_API_KEY",
    "CODEX_RESPONSES_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL"
  ]);
});

test("direct providers win over overlapping subscription-provider removals", () => {
  const anthropic = serviceEnvironment(
    parseRouterConfig({
      providers: { anthropic: {}, "claude-code": {} },
      defaultModel: "anthropic/test-model"
    }),
    {
      ANTHROPIC_API_KEY: "direct-key",
      ANTHROPIC_BASE_URL: "https://anthropic.example",
      ANTHROPIC_AUTH_TOKEN: "native-token"
    }
  );
  assert.equal(anthropic.set.ANTHROPIC_API_KEY, "direct-key");
  assert.equal(anthropic.set.ANTHROPIC_BASE_URL, "https://anthropic.example");
  assert.deepEqual(anthropic.unset, ["ANTHROPIC_AUTH_TOKEN"]);

  const openai = serviceEnvironment(
    parseRouterConfig({
      providers: { openai: {}, codex: {} },
      defaultModel: "openai/test-model"
    }),
    {
      OPENAI_API_KEY: "direct-key",
      OPENAI_BASE_URL: "https://openai.example",
      CODEX_API_KEY: "native-key",
      CODEX_RESPONSES_BASE_URL: "https://codex.example"
    }
  );
  assert.equal(openai.set.OPENAI_API_KEY, "direct-key");
  assert.equal(openai.set.OPENAI_BASE_URL, "https://openai.example");
  assert.deepEqual(openai.unset, ["CODEX_API_KEY", "CODEX_RESPONSES_BASE_URL"]);
});

test("CLIProxy services resolve explicit and managed credentials", () => {
  const config = parseRouterConfig({
    providers: { cliproxy: {} },
    defaultModel: "cliproxy/test-model"
  });
  const explicit = serviceEnvironment(config, {
    ROUTEKIT_CLIPROXY_API_KEY: "explicit-key",
    ROUTEKIT_CLIPROXY_BASE_URL: "http://127.0.0.1:9000"
  });
  assert.equal(explicit.set.ROUTEKIT_CLIPROXY_API_KEY, "explicit-key");
  assert.equal(explicit.set.ROUTEKIT_CLIPROXY_BASE_URL, "http://127.0.0.1:9000");

  const home = mkdtempSync(join(tmpdir(), "routekit-cliproxy-service-env-"));
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), 'api-keys:\n  - "managed-key"\n');
    const managed = serviceEnvironment(config, { ROUTEKIT_CLIPROXY_HOME: home });
    assert.equal(managed.set.ROUTEKIT_CLIPROXY_API_KEY, "managed-key");
    assert.equal(managed.set.ROUTEKIT_CLIPROXY_BASE_URL, "http://127.0.0.1:8317");
    assert.deepEqual(
      missingServiceCredentialVariables(config, {
        ROUTEKIT_CLIPROXY_HOME: home
      }),
      []
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const awsEnvironmentNames = [
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_SDK_LOAD_CONFIG",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_STS_REGIONAL_ENDPOINTS"
] as const;

function bedrockConfig(): RouterConfig {
  return parseRouterConfig({ providers: { bedrock: {} } });
}

test("configured Bedrock services preserve present chain inputs and remove absent ones", () => {
  const source: NodeJS.ProcessEnv = {
    AWS_REGION: "us-east-1",
    AWS_PROFILE: "routekit",
    AWS_CONTAINER_AUTHORIZATION_TOKEN: "do-not-persist"
  };
  const environment = serviceEnvironment(bedrockConfig(), source);
  assert.equal(environment.set.AWS_REGION, "us-east-1");
  assert.equal(environment.set.AWS_PROFILE, "routekit");
  assert.equal(environment.set.AWS_CONTAINER_AUTHORIZATION_TOKEN, undefined);
  assert.ok(environment.unset.includes("AWS_CONTAINER_AUTHORIZATION_TOKEN"));
  for (const name of awsEnvironmentNames) {
    if (source[name] === undefined) assert.ok(environment.unset.includes(name), `missing ${name}`);
  }
  assert.deepEqual(missingServiceCredentialVariables(bedrockConfig(), {}), []);
});

test("unconfigured Bedrock does not leak AWS credential-chain inputs", () => {
  const source = Object.fromEntries(awsEnvironmentNames.map((name) => [name, `secret-${name}`]));
  const environment = serviceEnvironment(
    parseRouterConfig({
      providers: { openai: {} },
      defaultModel: "openai/test-model"
    }),
    { ...source, OPENAI_API_KEY: "openai-key" }
  );
  for (const name of awsEnvironmentNames) {
    assert.equal(environment.set[name], undefined, `copied ${name}`);
    assert.equal(environment.unset.includes(name), false, `claimed ${name}`);
  }
});

test("daemon unit specs persist the unset-name manifest without credential values", () => {
  const previous = process.env.ROUTEKIT_HOME;
  const home = mkdtempSync(join(tmpdir(), "routekit-service-manifest-"));
  process.env.ROUTEKIT_HOME = home;
  try {
    const environment = {
      set: { ANTHROPIC_API_KEY: "private-key" },
      unset: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]
    };
    const launchd = daemonUnitSpec({
      args: ["daemon", "run"],
      supervisor: "launchd",
      env: environment,
      drainGraceMs: 30_000
    });
    assert.equal(launchd.env?.ANTHROPIC_API_KEY, "private-key");
    assert.equal(launchd.env?.[SERVICE_UNSET_ENV], '["ANTHROPIC_AUTH_TOKEN","ANTHROPIC_BASE_URL"]');

    const systemd = daemonUnitSpec({
      args: ["daemon", "run"],
      supervisor: "systemd",
      env: environment,
      drainGraceMs: 30_000
    });
    const file = readFileSync(systemd.environmentFile!, "utf8");
    assert.match(file, /ANTHROPIC_API_KEY="private-key"/);
    assert.match(file, new RegExp(`${SERVICE_UNSET_ENV}=`));
    assert.doesNotMatch(file, /native-client-token/);
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("service environment contract detection distinguishes legacy artifacts", () => {
  const previousRoutekitHome = process.env.ROUTEKIT_HOME;
  const previousHome = process.env.HOME;
  const root = mkdtempSync(join(tmpdir(), "routekit-service-contract-"));
  const home = join(root, "home");
  const stateHome = join(root, "state");
  process.env.HOME = home;
  process.env.ROUTEKIT_HOME = stateHome;
  try {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(join(stateHome, "env"), { recursive: true });
    const plist = join(home, "Library", "LaunchAgents", "com.routekit.daemon.plist");
    const envFile = join(stateHome, "env", "daemon.env");
    writeFileSync(plist, "legacy plist\n");
    writeFileSync(envFile, "LEGACY=value\n");
    assert.equal(serviceEnvironmentContractInstalled("launchd"), false);
    assert.equal(serviceEnvironmentContractInstalled("systemd"), false);
    writeFileSync(plist, `${SERVICE_UNSET_ENV}\n`);
    writeFileSync(envFile, `${SERVICE_UNSET_ENV}="[]"\n`);
    assert.equal(serviceEnvironmentContractInstalled("launchd"), true);
    assert.equal(serviceEnvironmentContractInstalled("systemd"), true);
  } finally {
    if (previousRoutekitHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousRoutekitHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("drain grace resolves flag, environment, and default in order", () => {
  const previous = process.env.ROUTEKIT_DRAIN_GRACE;
  delete process.env.ROUTEKIT_DRAIN_GRACE;
  try {
    assert.equal(drainGraceMs(undefined, {}), 30_000);
    assert.equal(drainGraceMs("5", {}), 5_000);
    assert.equal(drainGraceMs("0", {}), 0);
    process.env.ROUTEKIT_DRAIN_GRACE = "12";
    assert.equal(drainGraceMs(undefined, { ROUTEKIT_DRAIN_GRACE: "12" }), 12_000);
    assert.equal(drainGraceMs("5", { ROUTEKIT_DRAIN_GRACE: "12" }), 5_000);
    assert.throws(() => drainGraceMs("-1", {}));
    assert.throws(() => drainGraceMs("nope", {}));
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_DRAIN_GRACE;
    else process.env.ROUTEKIT_DRAIN_GRACE = previous;
  }
});

test("serve argv forces the local target so an active remote cannot block startup", () => {
  const args = daemonServeArgs({
    configPath: "/tmp/routekit-serve-args/router.yaml",
    port: 8787
  });
  assert.equal(args[0], "--local");
  assert.deepEqual(args.slice(1, 3), ["daemon", "run"]);
  assert.deepEqual(argsWithPort(args, "0").slice(0, 3), ["--local", "daemon", "run"]);
});

test("blue-green replacement argv rebinds the port to an ephemeral one", () => {
  assert.deepEqual(argsWithPort(["daemon", "run", "--port", "8080", "--no-portless"], "0"), [
    "daemon",
    "run",
    "--port",
    "0",
    "--no-portless"
  ]);
  assert.deepEqual(argsWithPort(["daemon", "run"], "0"), ["daemon", "run", "--port", "0"]);
});
