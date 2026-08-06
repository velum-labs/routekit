import assert from "node:assert/strict";
import test from "node:test";
import { parseBrokerConfig } from "../config.js";

const base = {
  host: "127.0.0.1",
  port: 8082,
  workloads: [
    {
      roleArn: "arn:aws:iam::123456789012:role/factory-private",
      accountId: "123456789012",
      trustDomain: "factory-private",
      routekitPrincipal: "factory-t3-private",
      awsAudiences: ["routekit-credentials-private"]
    }
  ],
  routekitIssuer: "https://routekit-workload.internal",
  routekitAudience: "routekit-gateway-production",
  credentialLifetimeSeconds: 300,
  kmsKeyId: "arn:aws:kms:us-west-2:123456789012:key/example",
  kmsKeyVersion: "example",
  region: "us-west-2"
};

test("broker config accepts multiple exact AWS issuers and audiences", () => {
  const parsed = parseBrokerConfig({
    ...base,
    awsIssuers: [
      {
        issuer: "https://private.tokens.sts.global.api.aws",
        audiences: ["routekit-credentials-production", "routekit-credentials-private"]
      },
      {
        issuer: "https://public.tokens.sts.global.api.aws",
        audiences: ["routekit-credentials-public"]
      }
    ]
  });
  assert.equal(parsed.awsIssuers.length, 2);
  assert.deepEqual(parsed.workloads[0]?.awsAudiences, ["routekit-credentials-private"]);
});

test("legacy single-issuer broker config remains readable during rolling upgrades", () => {
  const parsed = parseBrokerConfig({
    ...base,
    workloads: [{ ...base.workloads[0], awsAudiences: undefined }],
    awsIssuer: "https://private.tokens.sts.global.api.aws",
    awsAudience: "routekit-credentials-production"
  });
  assert.deepEqual(parsed.awsIssuers, [
    {
      issuer: "https://private.tokens.sts.global.api.aws",
      audiences: ["routekit-credentials-production"]
    }
  ]);
});

test("workloads cannot bind an audience that no trusted issuer accepts", () => {
  assert.throws(
    () =>
      parseBrokerConfig({
        ...base,
        awsIssuers: [
          {
            issuer: "https://private.tokens.sts.global.api.aws",
            audiences: ["routekit-credentials-production"]
          }
        ]
      }),
    /unconfigured audience/
  );
});
