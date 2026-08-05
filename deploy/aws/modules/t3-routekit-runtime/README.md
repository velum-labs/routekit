# T3 + RouteKit runtime module

This child module creates exactly one immutable trust domain in one AWS account,
region, and VPC. It has no provider or backend configuration and does not create
networking, KMS keys, RouteKit gateways, Tailscale policy, application services,
secrets, or public listeners.

The refresh input is named `runtime_lifecycle`; Terraform reserves `lifecycle`
as a module meta-argument, so that exact input name cannot be declared.

`mode = "personal"` creates one private EC2 instance and one separately retained,
encrypted home EBS volume. The volume has Terraform `prevent_destroy`; planned
retirement requires a final AWS Backup recovery point, detachment, and an explicit
state-removal decision. Normal module destruction intentionally stops at that
guard.

Set `personal.enabled = false` for the identity-registration phase. This creates
the role, retained home volume, policy, logging, and bootstrap contract without
starting a node. After the exact output role ARN is authorized by the central
tailnet workload identity, set it to `true` and apply again.

`mode = "pool"` creates a launch template, ASG, launch-readiness and termination-
drain hooks, custom EventBridge forwarding, 100%-to-200% rolling refresh defaults,
alarm rollback, and no persistent home volume. An external controller owns task
admission, affinity state, lifecycle heartbeats, and the decision to detach and
stop a node when a lossless 24-hour drain cannot finish. AWS lifecycle heartbeat
calls are renewed within the service limit; the configured drain timeout is the
controller's absolute deadline.

The baked AMI must contain T3, the RouteKit connector, runtime supervisor,
CloudWatch/SSM agents, hardening, and systemd units. It reads the nonsecret
bootstrap parameter named by the `routekit:bootstrap-parameter` instance tag,
downloads the exact versioned manifest, verifies its SHA-256/signature, mounts a
personal home volume by filesystem UUID when present, then starts services. The
launch hook is completed only after a real authenticated RouteKit inference.

No input or output accepts a token, private key, arbitrary IAM document, arbitrary
user data, mutable package version, or individual instance IP.

## Consume from another repository

Until a registry release is desired, pin the Git tag and module subdirectory:

```hcl
module "runtime" {
  source = "git::https://github.com/velum-labs/routekit.git//deploy/aws/modules/t3-routekit-runtime?ref=terraform-aws-t3-routekit-runtime-v1.0.0"
  # ...inputs...
}
```

Move the tag only after the clean-room example, live personal call, and isolated
pool validation have passed. Consumers update by changing `ref`, reviewing the
plan, and applying through their own provider alias and isolated backend.
