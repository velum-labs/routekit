import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { AutoScalingClient, CompleteLifecycleActionCommand } from "@aws-sdk/client-auto-scaling";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { type ConnectorConfig, parseConnectorConfig } from "./config.js";

type Bootstrap = {
  schema_version: number;
  mode: "personal" | "pool";
  name: string;
  environment: string;
  trust_domain: string;
  account_id: string;
  region: string;
  service_user: string;
  release_fingerprint: string;
  ami: {
    id: string;
    architecture: "x86_64" | "arm64";
    manifest_sha256: string;
    manifest_s3_arn: string;
    manifest_version_id: string;
  };
  routekit: {
    endpoint: string;
    principal: string;
    auth_mode: "credential_broker" | "secrets_manager";
    credential_broker_url?: string;
    credential_broker_audience?: string;
    routing_policy_version: string;
  };
  tailscale: {
    enabled: boolean;
    tags: string[];
    workload_identity_client_id?: string;
    workload_identity_audience?: string;
  };
};

type RuntimeManifest = {
  schema_version: 1;
  payload: {
    release: string;
    architecture: "x86_64" | "arm64";
    versions: Record<string, string>;
    files: Record<string, string>;
  };
  signature: string;
  signing_algorithm: "ECDSA_SHA_256";
};

type IdentityDocument = {
  accountId: string;
  architecture: string;
  imageId: string;
  instanceId: string;
  region: string;
};

const METADATA = "http://169.254.169.254/latest";
const CONNECTOR_CONFIG = "/etc/routekit-runtime/connector.json";
const MANIFEST_PATH = "/var/lib/routekit-runtime/manifest.json";

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("manifest contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("manifest contains an unsupported value");
}

function command(
  binary: string,
  args: string[],
  options: { user?: string; allowFailure?: boolean } = {}
): string {
  const actual =
    options.user === undefined
      ? { binary, args }
      : {
          binary: "/usr/sbin/runuser",
          args: [
            "--user",
            options.user,
            "--",
            "/usr/bin/env",
            `HOME=/home/${options.user}`,
            `XDG_RUNTIME_DIR=/run/user/${commandOutput("id", ["-u", options.user])}`,
            `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${commandOutput("id", ["-u", options.user])}/bus`,
            "PATH=/opt/routekit-runtime/t3-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            binary,
            ...args
          ]
        };
  const result = spawnSync(actual.binary, actual.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${binary} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function commandOutput(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${binary} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function metadata(path: string, token: string): Promise<string> {
  const response = await fetch(`${METADATA}/${path}`, {
    headers: { "x-aws-ec2-metadata-token": token },
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`IMDS ${path} returned HTTP ${response.status}`);
  return await response.text();
}

async function metadataToken(): Promise<string> {
  const response = await fetch(`${METADATA}/api/token`, {
    method: "PUT",
    headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`IMDS token returned HTTP ${response.status}`);
  return await response.text();
}

function parseS3Arn(arn: string): { bucket: string; key: string } {
  const match = /^arn:[^:]+:s3:::([^/]+)\/(.+)$/.exec(arn);
  if (match?.[1] === undefined || match[2] === undefined)
    throw new Error("invalid manifest S3 ARN");
  return { bucket: match[1], key: match[2] };
}

async function loadBootstrap(parameterName: string, region: string): Promise<Bootstrap> {
  const response = await new SSMClient({ region }).send(
    new GetParameterCommand({ Name: parameterName })
  );
  if (response.Parameter?.Value === undefined) throw new Error("bootstrap parameter has no value");
  const value = JSON.parse(response.Parameter.Value) as Bootstrap;
  if (value.schema_version !== 1 || !["personal", "pool"].includes(value.mode)) {
    throw new Error("unsupported bootstrap schema");
  }
  return value;
}

async function loadManifest(bootstrap: Bootstrap, publicKeyPath: string): Promise<RuntimeManifest> {
  const location = parseS3Arn(bootstrap.ami.manifest_s3_arn);
  const response = await new S3Client({ region: bootstrap.region }).send(
    new GetObjectCommand({
      Bucket: location.bucket,
      Key: location.key,
      VersionId: bootstrap.ami.manifest_version_id
    })
  );
  if (response.Body === undefined) throw new Error("manifest object is empty");
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== bootstrap.ami.manifest_sha256) throw new Error("manifest SHA-256 mismatch");
  const manifest = JSON.parse(bytes.toString("utf8")) as RuntimeManifest;
  if (manifest.schema_version !== 1 || manifest.signing_algorithm !== "ECDSA_SHA_256") {
    throw new Error("unsupported runtime manifest");
  }
  const signature = Buffer.from(manifest.signature, "base64");
  if (
    !verify(
      "sha256",
      Buffer.from(canonical(manifest.payload), "utf8"),
      createPublicKey(readFileSync(publicKeyPath, "utf8")),
      signature
    )
  ) {
    throw new Error("runtime manifest signature is invalid");
  }
  return manifest;
}

function verifyInstalledFiles(manifest: RuntimeManifest): void {
  for (const [path, expected] of Object.entries(manifest.payload.files)) {
    if (
      (!path.startsWith("/opt/routekit-runtime/") && path !== "/opt/routekit/dist/index.js") ||
      !/^[0-9a-f]{64}$/.test(expected)
    ) {
      throw new Error("manifest file contract is invalid");
    }
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== expected) throw new Error(`installed file digest mismatch: ${path}`);
  }
}

function ensureUser(user: string): void {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || user === "root")
    throw new Error("unsafe service user");
  if (spawnSync("id", [user]).status !== 0)
    command("useradd", ["--create-home", "--shell", "/bin/bash", user]);
  command("loginctl", ["enable-linger", user]);
  const sudoers = `/etc/sudoers.d/routekit-t3-${user}`;
  writeFileSync(
    sudoers,
    `${user} ALL=(root) NOPASSWD: /usr/bin/loginctl enable-linger ${user}, /usr/bin/loginctl show-user ${user} -p Linger --value, /usr/bin/loginctl terminate-user ${user}\n`,
    { mode: 0o440 }
  );
  command("visudo", ["--check", "--file", sudoers]);
}

async function waitForDevice(volumeId: string): Promise<string> {
  const compact = volumeId.replaceAll("-", "");
  const path = `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${compact}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (existsSync(path)) return path;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`home volume ${volumeId} did not appear`);
}

async function mountPersonalHome(user: string, volumeId: string): Promise<void> {
  const device = await waitForDevice(volumeId);
  let filesystem = command("blkid", ["-o", "value", "-s", "TYPE", device], { allowFailure: true });
  if (filesystem.length === 0) {
    command("mkfs.ext4", ["-L", "ROUTEKIT_HOME", device]);
    filesystem = "ext4";
  }
  if (filesystem !== "ext4" && filesystem !== "xfs")
    throw new Error(`unsupported home filesystem ${filesystem}`);
  const uuid = command("blkid", ["-o", "value", "-s", "UUID", device]);
  const home = `/home/${user}`;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const fstab = existsSync("/etc/fstab") ? readFileSync("/etc/fstab", "utf8") : "";
  if (!fstab.includes(`UUID=${uuid} `)) {
    writeFileSync(
      "/etc/fstab",
      `${fstab.trimEnd()}\nUUID=${uuid} ${home} ${filesystem} defaults,nofail 0 2\n`
    );
  }
  const mounted = command("findmnt", ["--target", home], { allowFailure: true }).length > 0;
  if (!mounted) command("mount", [home]);
  // Restored snapshots can contain root-owned state from the source host. The
  // dedicated service user owns the whole persistent home, including .t3,
  // .codex, and .claude, so native user services can start after restore.
  command("chown", ["-R", `${user}:${user}`, home]);
  command("chmod", ["0700", home]);
}

async function enrollTailscale(bootstrap: Bootstrap): Promise<void> {
  if (!bootstrap.tailscale.enabled) return;
  const clientId = bootstrap.tailscale.workload_identity_client_id;
  const audience = bootstrap.tailscale.workload_identity_audience;
  if (clientId === undefined || audience === undefined)
    throw new Error("Tailscale workload identity is incomplete");
  command("systemctl", ["enable", "--now", "tailscaled"]);
  const status = command("tailscale", ["status", "--json"], { allowFailure: true });
  if (status.length > 0) {
    const parsed = JSON.parse(status) as { BackendState?: unknown };
    if (parsed.BackendState === "Running") return;
  }
  command("tailscale", [
    "up",
    `--client-id=${clientId}?ephemeral=${bootstrap.mode === "pool" ? "true" : "false"}&preauthorized=true`,
    `--audience=${audience}`,
    `--advertise-tags=${bootstrap.tailscale.tags.join(",")}`,
    `--hostname=${bootstrap.name}`,
    "--ssh"
  ]);
}

function writeRuntimeConfig(bootstrap: Bootstrap): ConnectorConfig {
  if (
    bootstrap.routekit.auth_mode !== "credential_broker" ||
    bootstrap.routekit.credential_broker_url === undefined ||
    bootstrap.routekit.credential_broker_audience === undefined
  ) {
    throw new Error("runtime supervisor requires credential_broker mode");
  }
  const config = parseConnectorConfig({
    host: "127.0.0.1",
    port: 8081,
    brokerUrl: bootstrap.routekit.credential_broker_url,
    brokerAudience: bootstrap.routekit.credential_broker_audience,
    routekitEndpoint: bootstrap.routekit.endpoint,
    trustDomain: bootstrap.trust_domain,
    routekitPrincipal: bootstrap.routekit.principal,
    region: bootstrap.region,
    credentialLifetimeSeconds: 300
  });
  mkdirSync("/etc/routekit-runtime", { recursive: true, mode: 0o755 });
  writeFileSync(CONNECTOR_CONFIG, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
  return config;
}

function configureT3(user: string): void {
  const home = `/home/${user}`;
  const shimDir = "/opt/routekit-runtime/t3-bin";
  mkdirSync(shimDir, { recursive: true, mode: 0o755 });
  writeFileSync(
    `${shimDir}/loginctl`,
    `#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = enable-linger ]; then\n  exec /usr/bin/sudo -n /usr/bin/loginctl enable-linger ${user}\nfi\nexec /usr/bin/loginctl "$@"\n`,
    { mode: 0o755 }
  );
  const root = `${home}/.config/routekit-runtime`;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const envPath = `${root}/t3.env`;
  writeFileSync(
    envPath,
    [
      "OPENAI_BASE_URL=http://127.0.0.1:8081/v1",
      "OPENAI_API_KEY=routekit-workload",
      "ANTHROPIC_BASE_URL=http://127.0.0.1:8081",
      "ANTHROPIC_AUTH_TOKEN=routekit-workload",
      "ROUTEKIT_GATEWAY_URL=http://127.0.0.1:8081"
    ].join("\n") + "\n",
    { mode: 0o600 }
  );
  command("chown", ["-R", `${user}:${user}`, root]);
  command("t3", ["service", "install"], { user });
  const uid = commandOutput("id", ["-u", user]);
  const unit = `${home}/.config/systemd/user/t3code.service`;
  if (!existsSync(unit)) throw new Error("T3 native systemd unit was not installed");
  const dropIn = `${unit}.d`;
  mkdirSync(dropIn, { recursive: true, mode: 0o700 });
  writeFileSync(`${dropIn}/20-routekit-runtime.conf`, `[Service]\nEnvironmentFile=${envPath}\n`, {
    mode: 0o600
  });
  command("chown", ["-R", `${user}:${user}`, dropIn]);
  command("systemctl", ["--user", "daemon-reload"], { user });
  command("systemctl", ["--user", "enable", "--now", "t3code.service"], { user });
  if (!existsSync(`/run/user/${uid}/bus`)) throw new Error("T3 user systemd bus is unavailable");
}

function configureTailscaleServe(bootstrap: Bootstrap): void {
  if (!bootstrap.tailscale.enabled) return;
  command("tailscale", ["serve", "--bg", "--https=443", "127.0.0.1:3773"]);
}

async function waitHttp(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return response;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${url} did not become ready: ${last}`);
}

async function inferenceSmoke(): Promise<void> {
  const models = (await (await waitHttp("http://127.0.0.1:8081/v1/models", 120_000)).json()) as {
    data?: Array<{ id?: unknown }>;
  };
  const model = models.data?.find((entry) => typeof entry.id === "string")?.id;
  if (typeof model !== "string") throw new Error("RouteKit returned no authenticated models");
  const response = await fetch("http://127.0.0.1:8081/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "Reply exactly ROUTEKIT_RUNTIME_READY" }]
        }
      ],
      stream: false
    }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`RouteKit inference smoke returned HTTP ${response.status}`);
  const body = await response.text();
  if (body.length < 20) throw new Error("RouteKit inference smoke returned an empty response");
}

async function publishMetrics(bootstrap: Bootstrap, healthy: boolean): Promise<void> {
  const disk = statfsSync(`/home/${bootstrap.service_user}`);
  const used = 100 - (disk.bavail / disk.blocks) * 100;
  await new CloudWatchClient({ region: bootstrap.region }).send(
    new PutMetricDataCommand({
      Namespace: "RouteKit/Runtime",
      MetricData: [
        {
          MetricName: "Heartbeat",
          Value: healthy ? 1 : 0,
          Unit: "Count",
          Dimensions: [{ Name: "TrustDomain", Value: bootstrap.trust_domain }]
        },
        {
          MetricName: "ManifestValid",
          Value: healthy ? 1 : 0,
          Unit: "Count",
          Dimensions: [{ Name: "TrustDomain", Value: bootstrap.trust_domain }]
        },
        {
          MetricName: "T3ServiceHealthy",
          Value:
            spawnSync("systemctl", ["--user", "is-active", "t3code.service"], {
              env: {
                ...process.env,
                XDG_RUNTIME_DIR: `/run/user/${commandOutput("id", ["-u", bootstrap.service_user])}`,
                DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${commandOutput("id", ["-u", bootstrap.service_user])}/bus`
              }
            }).status === 0
              ? 1
              : 0,
          Unit: "Count",
          Dimensions: [{ Name: "TrustDomain", Value: bootstrap.trust_domain }]
        },
        {
          MetricName: "RouteKitConnectorHealthy",
          Value: healthy ? 1 : 0,
          Unit: "Count",
          Dimensions: [{ Name: "TrustDomain", Value: bootstrap.trust_domain }]
        },
        {
          MetricName: "DiskUsedPercent",
          Value: used,
          Unit: "Percent",
          Dimensions: [{ Name: "TrustDomain", Value: bootstrap.trust_domain }]
        }
      ]
    })
  );
}

export async function runSupervisor(publicKeyPath: string): Promise<never> {
  const token = await metadataToken();
  const identity = JSON.parse(
    await metadata("dynamic/instance-identity/document", token)
  ) as IdentityDocument;
  const parameter = await metadata("meta-data/tags/instance/routekit:bootstrap-parameter", token);
  const bootstrap = await loadBootstrap(parameter, identity.region);
  if (
    bootstrap.account_id !== identity.accountId ||
    bootstrap.region !== identity.region ||
    bootstrap.ami.id !== identity.imageId ||
    bootstrap.ami.architecture !== identity.architecture
  ) {
    throw new Error("instance identity does not match immutable bootstrap contract");
  }
  const manifest = await loadManifest(bootstrap, publicKeyPath);
  if (manifest.payload.architecture !== bootstrap.ami.architecture)
    throw new Error("manifest architecture mismatch");
  verifyInstalledFiles(manifest);
  mkdirSync("/var/lib/routekit-runtime", { recursive: true, mode: 0o700 });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(MANIFEST_PATH, 0o600);

  ensureUser(bootstrap.service_user);
  if (bootstrap.mode === "personal") {
    const volume = await metadata("meta-data/tags/instance/routekit:home-volume", token);
    await mountPersonalHome(bootstrap.service_user, volume);
    // A lingering user manager may have started against the root filesystem
    // before the persistent home was mounted. Restart it so native T3 unit
    // discovery reads the mounted home, not the pre-mount directory.
    command("loginctl", ["terminate-user", bootstrap.service_user], { allowFailure: true });
  }
  await enrollTailscale(bootstrap);
  writeRuntimeConfig(bootstrap);
  command("systemctl", ["enable", "--now", "routekit-workload-connector.service"]);
  configureT3(bootstrap.service_user);
  await waitHttp("http://127.0.0.1:3773/health", 120_000);
  configureTailscaleServe(bootstrap);
  await inferenceSmoke();
  await publishMetrics(bootstrap, true);

  if (bootstrap.mode === "pool") {
    const group = await metadata("meta-data/tags/instance/aws:autoscaling:groupName", token);
    await new AutoScalingClient({ region: bootstrap.region }).send(
      new CompleteLifecycleActionCommand({
        AutoScalingGroupName: group,
        LifecycleHookName: `${bootstrap.name}-launch-readiness`,
        InstanceId: identity.instanceId,
        LifecycleActionResult: "CONTINUE"
      })
    );
  }

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    const connector = await fetch("http://127.0.0.1:8081/connector-health", {
      signal: AbortSignal.timeout(5_000)
    })
      .then((response) => response.ok)
      .catch(() => false);
    await publishMetrics(bootstrap, connector);
  }
}
