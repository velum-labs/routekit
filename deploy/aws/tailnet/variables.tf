variable "tailnet_id" {
  description = "Tailscale tailnet ID or legacy DNS name. Use '-' to infer it from the API credential."
  type        = string
  default     = "-"

  validation {
    condition     = var.tailnet_id == "-" || can(regex("^[A-Za-z0-9._-]{3,128}$", var.tailnet_id))
    error_message = "tailnet_id must be '-' or a valid Tailscale tailnet identifier."
  }
}

variable "name_prefix" {
  description = "Deprecated compatibility input retained for existing operator tfvars. Exact role subjects come only from workload_identities."
  type        = string
  default     = "routekit-prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, numbers, or hyphens."
  }
}

variable "factory_services_enabled" {
  description = "Create the shared Factory control and public-worker Services. Enable only when all four exact Factory identity entries are present."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.factory_services_enabled ||
      alltrue([
        for name in [
          "factory_control",
          "factory_public_worker_api",
          "factory_private_runtime",
          "factory_public_runtime"
        ] : contains(keys(var.workload_identities), name)
      ])
    )
    error_message = "factory_services_enabled requires all four exact Factory workload identity entries."
  }
}

variable "workload_identities" {
  description = "RouteKit and Factory workload identity slots. Every entry binds one exact role ARN to its own AWS account issuer."
  type = map(object({
    role            = string
    tag             = string
    aws_account_id  = string
    aws_oidc_issuer = string
    aws_role_arn    = string
  }))
  default = {
    gateway = {
      role            = "gateway"
      tag             = "tag:routekit-gateway"
      aws_account_id  = "111111111111"
      aws_oidc_issuer = "https://11111111-2222-3333-4444-555555555555.tokens.sts.global.api.aws"
      aws_role_arn    = "arn:aws:iam::111111111111:role/routekit-prod-gateway"
    }
    t3_a = {
      role            = "t3-a"
      tag             = "tag:t3-a"
      aws_account_id  = "111111111111"
      aws_oidc_issuer = "https://11111111-2222-3333-4444-555555555555.tokens.sts.global.api.aws"
      aws_role_arn    = "arn:aws:iam::111111111111:role/routekit-prod-t3-a"
    }
    t3_b = {
      role            = "t3-b"
      tag             = "tag:t3-b"
      aws_account_id  = "111111111111"
      aws_oidc_issuer = "https://11111111-2222-3333-4444-555555555555.tokens.sts.global.api.aws"
      aws_role_arn    = "arn:aws:iam::111111111111:role/routekit-prod-t3-b"
    }
  }

  validation {
    condition = (
      length(var.workload_identities) >= 2 &&
      contains(keys(var.workload_identities), "gateway") &&
      try(var.workload_identities.gateway.role == "gateway", false) &&
      try(var.workload_identities.gateway.tag == "tag:routekit-gateway", false) &&
      length(distinct([for identity in values(var.workload_identities) : identity.role])) == length(var.workload_identities) &&
      length(distinct([for identity in values(var.workload_identities) : identity.aws_role_arn])) == length(var.workload_identities) &&
      alltrue([
        for identity in values(var.workload_identities) :
        can(regex("^[a-z][a-z0-9-]{2,31}$", identity.role)) &&
        can(regex("^tag:[a-z][a-z0-9-]{1,62}$", identity.tag)) &&
        can(regex("^[0-9]{12}$", identity.aws_account_id)) &&
        can(regex(
          "^https://[0-9a-f-]+\\.tokens\\.sts\\.global\\.api\\.aws$",
          identity.aws_oidc_issuer
        )) &&
        can(regex(
          "^arn:[^:]+:iam::${identity.aws_account_id}:role/[A-Za-z0-9+=,.@_/-]+$",
          identity.aws_role_arn
        ))
      ])
    )
    error_message = "workload_identities must define the gateway plus one or more distinct safe workloads; every exact role ARN must match that entry's 12-digit account and exact AWS outbound-federation issuer."
  }
}
