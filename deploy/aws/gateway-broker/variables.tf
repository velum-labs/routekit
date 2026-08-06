variable "aws_profile" { type = string }
variable "region" {
  type    = string
  default = "us-west-2"
}
variable "name" {
  type    = string
  default = "routekit-workload-production"
}
variable "gateway_role_name" { type = string }
variable "aws_issuer" {
  description = "Deprecated single-issuer compatibility input. Use aws_issuers for multi-account workloads."
  type        = string
  default     = null
  nullable    = true
  validation {
    condition     = var.aws_issuer == null || can(regex("^https://[0-9a-f-]+\\.tokens\\.sts\\.global\\.api\\.aws$", var.aws_issuer))
    error_message = "aws_issuer must be the account outbound federation issuer."
  }
}
variable "aws_audience" {
  description = "Deprecated single-audience compatibility input paired with aws_issuer."
  type        = string
  default     = null
  nullable    = true
}
variable "aws_issuers" {
  description = "Exact outbound federation issuers and accepted broker audiences for every authorized AWS account."
  type = map(object({
    audiences = set(string)
    jwks_uri  = optional(string)
  }))
  default = {}
  validation {
    condition = alltrue([for issuer, config in var.aws_issuers :
      can(regex("^https://[0-9a-f-]+\\.tokens\\.sts\\.global\\.api\\.aws$", issuer)) &&
      length(config.audiences) > 0 &&
      alltrue([for audience in config.audiences : length(audience) > 0]) &&
      (config.jwks_uri == null || can(regex("^https://", config.jwks_uri)))
    ])
    error_message = "aws_issuers requires exact HTTPS AWS issuers and at least one nonempty audience each."
  }
}
variable "routekit_issuer" {
  type = string
  validation {
    condition     = can(regex("^https://", var.routekit_issuer))
    error_message = "routekit_issuer must use HTTPS."
  }
}
variable "routekit_audience" { type = string }
variable "runtime_bundle" {
  description = "Exact content-addressed runtime bundle the gateway may read for broker and daemon releases."
  type = object({
    s3_arn      = string
    sha256      = string
    kms_key_arn = string
  })
  validation {
    condition = (
      can(regex("^arn:[^:]+:s3:::[a-z0-9.-]+/sha256/[0-9a-f]{64}/runtime\\.tar\\.gz$", var.runtime_bundle.s3_arn)) &&
      can(regex("^[0-9a-f]{64}$", var.runtime_bundle.sha256)) &&
      endswith(var.runtime_bundle.s3_arn, "/sha256/${var.runtime_bundle.sha256}/runtime.tar.gz") &&
      can(regex("^arn:[^:]+:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]+$", var.runtime_bundle.kms_key_arn))
    )
    error_message = "runtime_bundle must be one exact content-addressed S3 object, its matching SHA-256, and a KMS key ARN."
  }
}
variable "workloads" {
  type = map(object({
    role_arn           = string
    trust_domain       = string
    routekit_principal = string
    source_vpc_id      = string
    aws_audiences      = optional(set(string), [])
  }))
  validation {
    condition = (
      length(var.workloads) > 0 &&
      length(distinct([for workload in values(var.workloads) : workload.role_arn])) == length(var.workloads) &&
      length(distinct([for workload in values(var.workloads) : workload.trust_domain])) == length(var.workloads) &&
      alltrue([for workload in values(var.workloads) :
        can(regex("^arn:[^:]+:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", workload.role_arn)) &&
        can(regex("^[a-z][a-z0-9-]{2,63}$", workload.trust_domain)) &&
        can(regex("^[a-z][a-z0-9-]{2,63}$", workload.routekit_principal)) &&
        can(regex("^vpc-[0-9a-f]+$", workload.source_vpc_id)) &&
        alltrue([for audience in workload.aws_audiences : length(audience) > 0])
      ])
    )
    error_message = "workloads require unique exact IAM roles and trust domains with safe principals, VPC IDs, and nonempty optional audiences."
  }
}
variable "tags" { type = map(string) }
