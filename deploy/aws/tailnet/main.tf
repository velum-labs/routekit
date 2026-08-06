resource "tailscale_federated_identity" "aws" {
  for_each = var.workload_identities

  description = "${each.value.role} AWS workload"
  issuer      = each.value.aws_oidc_issuer
  subject     = each.value.aws_role_arn
  scopes      = ["auth_keys"]
  tags        = [each.value.tag]
}

resource "tailscale_service" "routekit_gateway" {
  name    = "svc:routekit-gateway"
  comment = "Stable private RouteKit production gateway"
  ports   = ["tcp:443"]
  tags    = ["tag:routekit-gateway"]
}

resource "tailscale_service" "routekit_credentials" {
  name    = "svc:routekit-credentials-production"
  comment = "Short-lived RouteKit workload credential broker"
  ports   = ["tcp:443"]
  tags    = ["tag:routekit-gateway"]
}

resource "tailscale_service" "factory_control" {
  count = var.factory_services_enabled ? 1 : 0

  name    = "svc:factory-control"
  comment = "Capability-scoped Factory operator control plane"
  ports   = ["tcp:443"]
  tags    = ["tag:factory-control"]
}

resource "tailscale_service" "factory_worker_public" {
  count = var.factory_services_enabled ? 1 : 0

  name    = "svc:factory-worker-public"
  comment = "Factory public-runtime workload API"
  ports   = ["tcp:443"]
  tags    = ["tag:factory-worker-api"]
}
