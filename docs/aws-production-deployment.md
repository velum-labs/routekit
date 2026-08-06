# AWS production deployment

The public active/passive RouteKit and per-founder T3 deployment lives in
[`deploy/aws`](../deploy/aws/README.md). It covers AWS identity bootstrap,
Tailscale workload federation and policy, Terraform, gateway enrollment,
Linux T3 services, failover, backup restore drills, upgrades, revocation,
costs, provider terms, and safe destruction.

The stack is intentionally operator-applied. No AWS account ID, tailnet ID,
provider credential, RouteKit token, or Terraform state is committed.

Cross-account workloads share the single stable credential broker Service
documented in
[`deploy/aws/gateway-broker`](../deploy/aws/gateway-broker/README.md). Configure
every account's exact AWS outbound-federation issuer and bind every workload
role to its intended audience. Never make issuer matching permissive to add an
account.
