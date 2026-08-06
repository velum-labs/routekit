# Workload credential broker

This Terraform root authorizes exact AWS workload roles to exchange short-lived
AWS identity tokens for short-lived RouteKit JWTs. One highly available
Tailscale Service fronts the broker:

```text
svc:routekit-credentials-production
https://routekit-credentials-production.<tailnet>.ts.net
```

Callers may use distinct AWS token audiences while sharing that service. For
example, Factory uses `routekit-credentials-private` and
`routekit-credentials-public`. Configure every account's exact outbound
federation issuer in `aws_issuers`, and bind each workload to its intended
audience with `aws_audiences`.

The broker selects a verifier from the untrusted token issuer and audience, then
performs full signature, issuer, audience, lifetime, account, role, region, VPC,
and IMDSv2 validation. An issuer that is not explicitly configured is rejected;
multi-account support does not relax issuer validation.

## Rolling upgrade from the single-issuer broker

The application continues to parse the legacy `awsIssuer`/`awsAudience` SSM
document so the broker binary can be upgraded first without changing live
authorization.

1. Build and deploy a runtime bundle containing the multi-issuer broker.
2. Confirm both gateway broker processes are healthy on the legacy config.
3. Change this root from `aws_issuer`/`aws_audience` to `aws_issuers`, add exact
   workload roles and `aws_audiences`, and apply.
4. Restart the broker on the passive gateway and canary every workload.
5. Promote the passive gateway, repeat on the other gateway, then canary again.

Do not apply the new `awsIssuers` SSM shape while either gateway still runs a
broker binary that only understands the legacy shape.
