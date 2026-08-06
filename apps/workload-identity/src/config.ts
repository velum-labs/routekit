import { readFileSync } from "node:fs";

export type BrokerWorkload = {
  roleArn: string;
  accountId: string;
  trustDomain: string;
  routekitPrincipal: string;
  awsAudiences?: string[];
  sourceVpcId?: string;
  sourceRegion?: string;
};

export type BrokerAwsIssuer = {
  issuer: string;
  audiences: string[];
  jwksUri?: string;
};

export type BrokerConfig = {
  host: string;
  port: number;
  awsIssuers: BrokerAwsIssuer[];
  workloads: BrokerWorkload[];
  routekitIssuer: string;
  routekitAudience: string;
  credentialLifetimeSeconds: number;
  kmsKeyId: string;
  kmsKeyVersion: string;
  region: string;
};

export type ConnectorConfig = {
  host: string;
  port: number;
  brokerUrl: string;
  brokerAudience: string;
  routekitEndpoint: string;
  trustDomain: string;
  routekitPrincipal: string;
  region: string;
  credentialLifetimeSeconds: number;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function url(value: unknown, label: string, allowHttpLoopback = false): string {
  const parsed = new URL(string(value, label));
  if (
    parsed.protocol !== "https:" &&
    !(
      allowHttpLoopback &&
      parsed.protocol === "http:" &&
      ["127.0.0.1", "::1"].includes(parsed.hostname)
    )
  ) {
    throw new Error(`${label} must use HTTPS${allowHttpLoopback ? " or loopback HTTP" : ""}`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function host(value: unknown, label: string): string {
  const result = string(value, label);
  if (!["127.0.0.1", "::1"].includes(result)) throw new Error(`${label} must be loopback`);
  return result;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown keys: ${unknown.join(", ")}`);
}

export function parseBrokerConfig(value: unknown): BrokerConfig {
  const input = object(value, "broker config");
  exactKeys(
    input,
    [
      "host",
      "port",
      "awsIssuer",
      "awsAudience",
      "awsJwksUri",
      "awsIssuers",
      "workloads",
      "routekitIssuer",
      "routekitAudience",
      "credentialLifetimeSeconds",
      "kmsKeyId",
      "kmsKeyVersion",
      "region"
    ],
    "broker config"
  );
  if (!Array.isArray(input.workloads) || input.workloads.length === 0) {
    throw new Error("broker config workloads must be a non-empty array");
  }
  const legacyIssuerConfigured =
    input.awsIssuer !== undefined ||
    input.awsAudience !== undefined ||
    input.awsJwksUri !== undefined;
  if (legacyIssuerConfigured && input.awsIssuers !== undefined) {
    throw new Error("broker config must use awsIssuers or the legacy AWS issuer fields, not both");
  }
  let awsIssuers: BrokerAwsIssuer[];
  if (input.awsIssuers !== undefined) {
    if (!Array.isArray(input.awsIssuers) || input.awsIssuers.length === 0) {
      throw new Error("broker config awsIssuers must be a non-empty array");
    }
    awsIssuers = input.awsIssuers.map((entry, index): BrokerAwsIssuer => {
      const issuer = object(entry, `awsIssuers[${index}]`);
      exactKeys(issuer, ["issuer", "audiences", "jwksUri"], `awsIssuers[${index}]`);
      if (!Array.isArray(issuer.audiences) || issuer.audiences.length === 0) {
        throw new Error(`awsIssuers[${index}].audiences must be a non-empty array`);
      }
      const parsedAudiences = issuer.audiences.map((entry, audienceIndex) =>
        string(entry, `awsIssuers[${index}].audiences[${audienceIndex}]`)
      );
      if (new Set(parsedAudiences).size !== parsedAudiences.length) {
        throw new Error(`awsIssuers[${index}].audiences must be unique`);
      }
      return {
        issuer: url(issuer.issuer, `awsIssuers[${index}].issuer`),
        audiences: parsedAudiences,
        ...(issuer.jwksUri === undefined
          ? {}
          : { jwksUri: url(issuer.jwksUri, `awsIssuers[${index}].jwksUri`) })
      };
    });
  } else {
    awsIssuers = [
      {
        issuer: url(input.awsIssuer, "broker config awsIssuer"),
        audiences: [string(input.awsAudience, "broker config awsAudience")],
        ...(input.awsJwksUri === undefined
          ? {}
          : { jwksUri: url(input.awsJwksUri, "broker config awsJwksUri") })
      }
    ];
  }
  if (new Set(awsIssuers.map((entry) => entry.issuer)).size !== awsIssuers.length) {
    throw new Error("each broker AWS issuer must be unique");
  }
  const workloads = input.workloads.map((entry, index): BrokerWorkload => {
    const workload = object(entry, `workloads[${index}]`);
    exactKeys(
      workload,
      [
        "roleArn",
        "accountId",
        "trustDomain",
        "routekitPrincipal",
        "awsAudiences",
        "sourceVpcId",
        "sourceRegion"
      ],
      `workloads[${index}]`
    );
    const roleArn = string(workload.roleArn, `workloads[${index}].roleArn`);
    const accountId = string(workload.accountId, `workloads[${index}].accountId`);
    if (!new RegExp(`^arn:aws:iam::${accountId}:role/[A-Za-z0-9+=,.@_/-]+$`).test(roleArn)) {
      throw new Error(`workloads[${index}].roleArn must be an IAM role in its accountId`);
    }
    let awsAudiences: string[] | undefined;
    if (workload.awsAudiences !== undefined) {
      if (!Array.isArray(workload.awsAudiences) || workload.awsAudiences.length === 0) {
        throw new Error(`workloads[${index}].awsAudiences must be a non-empty array`);
      }
      awsAudiences = workload.awsAudiences.map((entry, audienceIndex) =>
        string(entry, `workloads[${index}].awsAudiences[${audienceIndex}]`)
      );
      if (new Set(awsAudiences).size !== awsAudiences.length) {
        throw new Error(`workloads[${index}].awsAudiences must be unique`);
      }
      const configuredAudiences = new Set(awsIssuers.flatMap((entry) => entry.audiences));
      if (awsAudiences.some((audience) => !configuredAudiences.has(audience))) {
        throw new Error(`workloads[${index}].awsAudiences contains an unconfigured audience`);
      }
    }
    return {
      roleArn,
      accountId,
      trustDomain: string(workload.trustDomain, `workloads[${index}].trustDomain`),
      routekitPrincipal: string(
        workload.routekitPrincipal,
        `workloads[${index}].routekitPrincipal`
      ),
      ...(awsAudiences === undefined ? {} : { awsAudiences }),
      ...(workload.sourceVpcId === undefined
        ? {}
        : { sourceVpcId: string(workload.sourceVpcId, `workloads[${index}].sourceVpcId`) }),
      ...(workload.sourceRegion === undefined
        ? {}
        : { sourceRegion: string(workload.sourceRegion, `workloads[${index}].sourceRegion`) })
    };
  });
  if (new Set(workloads.map((entry) => entry.trustDomain)).size !== workloads.length) {
    throw new Error("each broker workload trustDomain must be unique");
  }
  return {
    host: host(input.host, "broker config host"),
    port: integer(input.port, "broker config port", 1, 65535),
    awsIssuers,
    workloads,
    routekitIssuer: url(input.routekitIssuer, "broker config routekitIssuer"),
    routekitAudience: string(input.routekitAudience, "broker config routekitAudience"),
    credentialLifetimeSeconds: integer(
      input.credentialLifetimeSeconds,
      "broker config credentialLifetimeSeconds",
      60,
      600
    ),
    kmsKeyId: string(input.kmsKeyId, "broker config kmsKeyId"),
    kmsKeyVersion: string(input.kmsKeyVersion, "broker config kmsKeyVersion"),
    region: string(input.region, "broker config region")
  };
}

export function parseConnectorConfig(value: unknown): ConnectorConfig {
  const input = object(value, "connector config");
  exactKeys(
    input,
    [
      "host",
      "port",
      "brokerUrl",
      "brokerAudience",
      "routekitEndpoint",
      "trustDomain",
      "routekitPrincipal",
      "region",
      "credentialLifetimeSeconds"
    ],
    "connector config"
  );
  return {
    host: host(input.host, "connector config host"),
    port: integer(input.port, "connector config port", 1, 65535),
    brokerUrl: url(input.brokerUrl, "connector config brokerUrl", true),
    brokerAudience: string(input.brokerAudience, "connector config brokerAudience"),
    routekitEndpoint: url(input.routekitEndpoint, "connector config routekitEndpoint", true),
    trustDomain: string(input.trustDomain, "connector config trustDomain"),
    routekitPrincipal: string(input.routekitPrincipal, "connector config routekitPrincipal"),
    region: string(input.region, "connector config region"),
    credentialLifetimeSeconds: integer(
      input.credentialLifetimeSeconds,
      "connector config credentialLifetimeSeconds",
      60,
      300
    )
  };
}

export function readJsonConfig(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
