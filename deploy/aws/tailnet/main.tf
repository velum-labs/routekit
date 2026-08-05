resource "tailscale_federated_identity" "aws" {
  for_each = var.workload_identities

  description = "RouteKit ${each.value.role} AWS workload"
  issuer      = var.aws_oidc_issuer
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
