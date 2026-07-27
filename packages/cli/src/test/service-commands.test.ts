import assert from "node:assert/strict";
import test from "node:test";

import { parseRouterConfig, type RouterConfig } from "@velum-labs/routekit-gateway";

import { daemonServeArgs } from "../client.js";
import { drainGraceMs } from "../commands/serve-options.js";
import { argsWithPort } from "../commands/upgrade.js";
import {
  daemonUnitSpec,
  missingServiceCredentialVariables,
  serviceEnvironment
} from "../daemon.js";

test("daemon service units use stable RouteKit state as their working directory", () => {
  const previous = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = "/tmp/routekit-stable-home";
  try {
    const spec = daemonUnitSpec({
      args: ["daemon", "run"],
      supervisor: "launchd",
      env: {},
      drainGraceMs: 30_000
    });
    assert.equal(spec.workingDirectory, "/tmp/routekit-stable-home");
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
  }
});

test("daemon services capture credentials only for configured providers", () => {
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = "configured-secret";
  process.env.ANTHROPIC_API_KEY = "unrelated-secret";
  try {
    const env = serviceEnvironment(
      parseRouterConfig({
        providers: { openai: {} },
        defaultModel: "openai/test-model"
      })
    );
    assert.equal(env.OPENAI_API_KEY, "configured-secret");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(
      missingServiceCredentialVariables(
        parseRouterConfig({
          providers: { openai: {} },
          defaultModel: "openai/test-model"
        }),
        {}
      ),
      ["OPENAI_API_KEY"]
    );
  } finally {
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropic;
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

test("configured Bedrock daemon preserves AWS default-chain inputs", () => {
  const previous = new Map(
    awsEnvironmentNames.map((name) => [name, process.env[name]] as const)
  );
  const previousAuthorizationToken = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
  try {
    for (const name of awsEnvironmentNames) process.env[name] = `value-for-${name}`;
    // A direct authorization token is deliberately excluded; the SDK can read
    // its refreshable value from AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE.
    process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN = "do-not-persist";

    const env = serviceEnvironment(bedrockConfig());
    for (const name of awsEnvironmentNames) {
      assert.equal(env[name], `value-for-${name}`, `missing ${name}`);
    }
    assert.equal(env.AWS_CONTAINER_AUTHORIZATION_TOKEN, undefined);
    assert.deepEqual(missingServiceCredentialVariables(bedrockConfig(), {}), []);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (previousAuthorizationToken === undefined) {
      delete process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    } else {
      process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN = previousAuthorizationToken;
    }
  }
});

test("unconfigured Bedrock does not leak AWS credential-chain inputs", () => {
  const previous = new Map(
    awsEnvironmentNames.map((name) => [name, process.env[name]] as const)
  );
  try {
    for (const name of awsEnvironmentNames) process.env[name] = `secret-${name}`;
    const env = serviceEnvironment(
      parseRouterConfig({
        providers: { openai: {} },
        defaultModel: "openai/test-model"
      })
    );
    for (const name of awsEnvironmentNames) {
      assert.equal(env[name], undefined, `leaked ${name}`);
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("drain grace resolves flag, environment, and default in order", () => {
  const previous = process.env.ROUTEKIT_DRAIN_GRACE;
  delete process.env.ROUTEKIT_DRAIN_GRACE;
  try {
    assert.equal(drainGraceMs(undefined), 30_000);
    assert.equal(drainGraceMs("5"), 5_000);
    assert.equal(drainGraceMs("0"), 0);
    process.env.ROUTEKIT_DRAIN_GRACE = "12";
    assert.equal(drainGraceMs(undefined), 12_000);
    assert.equal(drainGraceMs("5"), 5_000);
    assert.throws(() => drainGraceMs("-1"));
    assert.throws(() => drainGraceMs("nope"));
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
  assert.deepEqual(
    argsWithPort(["daemon", "run", "--port", "8080", "--no-portless"], "0"),
    ["daemon", "run", "--port", "0", "--no-portless"]
  );
  assert.deepEqual(argsWithPort(["daemon", "run"], "0"), [
    "daemon",
    "run",
    "--port",
    "0"
  ]);
});
