variable "tailnet_id" {
  description = "Tailscale tailnet ID or legacy DNS name. Use '-' to infer it from the API credential."
  type        = string
  default     = "-"

  validation {
    condition     = var.tailnet_id == "-" || can(regex("^[A-Za-z0-9._-]{3,128}$", var.tailnet_id))
    error_message = "tailnet_id must be '-' or a valid Tailscale tailnet identifier."
  }
}

variable "aws_account_id" {
  description = "AWS account containing the RouteKit EC2 instance roles."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must contain exactly 12 digits."
  }
}

variable "aws_oidc_issuer" {
  description = "IssuerIdentifier returned by aws iam get-outbound-web-identity-federation-info."
  type        = string

  validation {
    condition = can(regex(
      "^https://[0-9a-f-]+\\.tokens\\.sts\\.global\\.api\\.aws$",
      var.aws_oidc_issuer
    ))
    error_message = "aws_oidc_issuer must be the account-specific AWS STS outbound identity issuer."
  }
}

variable "name_prefix" {
  description = "Must match the AWS stack name_prefix so IAM role subjects are exact."
  type        = string
  default     = "routekit-prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, numbers, or hyphens."
  }
}

variable "workload_identities" {
  description = "Gateway and T3 workload identity slots keyed by deployment-chosen logical names."
  type = map(object({
    role         = string
    tag          = string
    aws_role_arn = string
  }))
  default = {
    gateway = {
      role         = "gateway"
      tag          = "tag:routekit-gateway"
      aws_role_arn = "arn:aws:iam::123456789012:role/routekit-prod-gateway"
    }
    t3_a = {
      role         = "t3-a"
      tag          = "tag:t3-a"
      aws_role_arn = "arn:aws:iam::123456789012:role/routekit-prod-t3-a"
    }
    t3_b = {
      role         = "t3-b"
      tag          = "tag:t3-b"
      aws_role_arn = "arn:aws:iam::123456789012:role/routekit-prod-t3-b"
    }
  }

  validation {
    condition = (
      length(var.workload_identities) >= 2 &&
      contains(keys(var.workload_identities), "gateway") &&
      try(var.workload_identities.gateway.role == "gateway", false) &&
      try(var.workload_identities.gateway.tag == "tag:routekit-gateway", false) &&
      length(distinct([for identity in values(var.workload_identities) : identity.role])) == length(var.workload_identities) &&
      alltrue([
        for identity in values(var.workload_identities) :
        can(regex("^[a-z][a-z0-9-]{2,31}$", identity.role)) &&
        can(regex("^tag:[a-z][a-z0-9-]{1,62}$", identity.tag)) &&
        can(regex("^arn:[^:]+:iam::${var.aws_account_id}:role/[A-Za-z0-9+=,.@_/-]+$", identity.aws_role_arn))
      ])
    )
    error_message = "workload_identities must define the gateway plus one or more distinct safe T3 role and tag pairs."
  }
}
