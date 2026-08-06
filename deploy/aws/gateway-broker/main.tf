data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_iam_role" "gateway" { name = var.gateway_role_name }

resource "aws_kms_key" "credentials" {
  description              = "Short-lived RouteKit workload credential signing"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_NIST_P256"
  deletion_window_in_days  = 30
  tags                     = merge(var.tags, { Name = var.name })
  lifecycle { prevent_destroy = true }
}

resource "aws_kms_alias" "credentials" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.credentials.key_id
}

data "aws_kms_public_key" "credentials" {
  key_id = aws_kms_key.credentials.arn
}

locals {
  legacy_aws_issuers = var.aws_issuer == null || var.aws_audience == null ? {} : {
    (var.aws_issuer) = {
      audiences = toset([var.aws_audience])
      jwks_uri  = null
    }
  }
  normalized_aws_issuers = length(var.aws_issuers) > 0 ? var.aws_issuers : local.legacy_aws_issuers
  configured_aws_audiences = toset(flatten([
    for _, config in local.normalized_aws_issuers : tolist(config.audiences)
  ]))

  broker_config = {
    host = "127.0.0.1"
    port = 8082
    awsIssuers = [for issuer, config in local.normalized_aws_issuers : merge(
      {
        issuer    = issuer
        audiences = sort(tolist(config.audiences))
      },
      config.jwks_uri == null ? {} : { jwksUri = config.jwks_uri }
    )]
    workloads = [for name, workload in var.workloads : merge(
      {
        roleArn           = workload.role_arn
        accountId         = split(":", workload.role_arn)[4]
        trustDomain       = workload.trust_domain
        routekitPrincipal = workload.routekit_principal
        sourceVpcId       = workload.source_vpc_id
        sourceRegion      = var.region
      },
      length(workload.aws_audiences) == 0 ? {} : {
        awsAudiences = sort(tolist(workload.aws_audiences))
      }
    )]
    routekitIssuer            = var.routekit_issuer
    routekitAudience          = var.routekit_audience
    credentialLifetimeSeconds = 300
    kmsKeyId                  = aws_kms_key.credentials.arn
    kmsKeyVersion             = aws_kms_key.credentials.key_id
    region                    = var.region
  }
}

check "aws_issuer_contract" {
  assert {
    condition = (
      (length(var.aws_issuers) > 0 && var.aws_issuer == null && var.aws_audience == null) ||
      (length(var.aws_issuers) == 0 && var.aws_issuer != null && var.aws_audience != null)
    )
    error_message = "Configure either aws_issuers or the legacy aws_issuer/aws_audience pair."
  }
}

check "workload_audience_contract" {
  assert {
    condition = alltrue([for workload in values(var.workloads) :
      length(workload.aws_audiences) == 0 ||
      alltrue([for audience in workload.aws_audiences : contains(local.configured_aws_audiences, audience)])
    ])
    error_message = "Every workload aws_audiences entry must be accepted by a configured AWS issuer."
  }
}

resource "aws_ssm_parameter" "config" {
  name        = "/routekit/workload-broker/production/config"
  description = "Nonsecret exact workload authorization and signing references"
  type        = "String"
  value       = jsonencode(local.broker_config)
  tags        = var.tags
}

resource "aws_ssm_parameter" "verifier_config" {
  name        = "/routekit/gateway/production/workload-jwt-config"
  description = "Nonsecret RouteKit workload JWT public-key and exact principal policy"
  type        = "String"
  value = jsonencode({
    issuer   = var.routekit_issuer
    audience = var.routekit_audience
    publicKeys = {
      (aws_kms_key.credentials.key_id) = data.aws_kms_public_key.credentials.public_key_pem
    }
    principals = [for name, workload in var.workloads : {
      subject     = workload.role_arn
      trustDomain = workload.trust_domain
      principal   = workload.routekit_principal
      role        = "admin"
    }]
    maxLifetimeSeconds = 300
    clockSkewSeconds   = 30
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "gateway_broker" {
  name = "routekit-workload-broker"
  role = data.aws_iam_role.gateway.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SignShortLivedWorkloadCredentials"
        Effect   = "Allow"
        Action   = ["kms:Sign", "kms:GetPublicKey"]
        Resource = aws_kms_key.credentials.arn
      },
      {
        Sid      = "ReadBrokerAuthorizationConfig"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = [aws_ssm_parameter.config.arn, aws_ssm_parameter.verifier_config.arn]
      },
      {
        Sid      = "ReadExactGatewayRuntimeBundle"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = var.runtime_bundle.s3_arn
      },
      {
        Sid      = "DecryptGatewayRuntimeBundle"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.runtime_bundle.kms_key_arn
        Condition = {
          StringEquals = {
            "kms:ViaService" = "s3.${var.region}.${data.aws_partition.current.dns_suffix}"
          }
        }
      }
    ]
  })
}
