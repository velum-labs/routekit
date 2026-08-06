resource "aws_iam_role" "runtime" {
  name        = var.runtime_role_name
  name_prefix = var.runtime_role_name == null ? "${var.name}-runtime-" : null
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.common_tags
}

resource "aws_iam_instance_profile" "runtime" {
  name_prefix = "${var.name}-runtime-"
  role        = aws_iam_role.runtime.name
  tags        = local.common_tags
}

resource "aws_ssm_parameter" "bootstrap" {
  name        = local.bootstrap_parameter_name
  description = "Nonsecret immutable RouteKit runtime bootstrap contract"
  type        = "String"
  value       = jsonencode(local.bootstrap)
  tags        = local.common_tags
}

resource "aws_iam_role_policy" "runtime" {
  name_prefix = "runtime-"
  role        = aws_iam_role.runtime.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid      = "ReadImmutableBootstrap"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = aws_ssm_parameter.bootstrap.arn
      },
      {
        Sid      = "ReadImmutableManifest"
        Effect   = "Allow"
        Action   = ["s3:GetObjectVersion"]
        Resource = var.ami.manifest_s3_arn
        Condition = {
          StringEquals = { "s3:VersionId" = var.ami.manifest_version_id }
        }
      },
      {
        Sid      = "DecryptImmutableManifest"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.ami.manifest_kms_key_arn
        Condition = {
          StringEquals = {
            "kms:ViaService" = "s3.${var.region}.${data.aws_partition.current.dns_suffix}"
          }
        }
      },
      {
        Sid    = "SsmManagedInstance"
        Effect = "Allow"
        Action = [
          "ssm:UpdateInstanceInformation",
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel"
        ]
        Resource = "*"
      },
      {
        Sid      = "WriteRuntimeLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"]
        Resource = [for group in aws_cloudwatch_log_group.runtime : "${group.arn}:*"]
      },
      {
        Sid      = "WriteRuntimeMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
        Condition = {
          StringEquals = { "cloudwatch:namespace" = "RouteKit/Runtime" }
        }
      },
      {
        Sid      = "GetWorkloadIdentity"
        Effect   = "Allow"
        Action   = ["sts:GetWebIdentityToken"]
        Resource = "*"
        Condition = {
          "ForAnyValue:StringEquals" = {
            "sts:IdentityTokenAudience" = compact([
              var.routekit.auth_mode == "credential_broker" ? var.routekit.credential_broker_audience : null,
              var.tailscale.enabled ? var.tailscale.workload_identity_audience : null
            ])
          }
          NumericLessThanEquals = { "sts:DurationSeconds" = 300 }
        }
      },
      {
        Sid      = "TagWorkloadIdentity"
        Effect   = "Allow"
        Action   = ["sts:TagGetWebIdentityToken"]
        Resource = "*"
        Condition = {
          "ForAnyValue:StringEquals" = {
            "sts:IdentityTokenAudience" = compact([
              var.routekit.auth_mode == "credential_broker" ? var.routekit.credential_broker_audience : null,
              var.tailscale.enabled ? var.tailscale.workload_identity_audience : null
            ])
            "aws:TagKeys" = ["trust-domain", "routekit-principal"]
          }
          "StringEquals" = {
            "aws:RequestTag/trust-domain"       = var.trust_domain
            "aws:RequestTag/routekit-principal" = var.routekit.principal
          }
          NumericLessThanEquals = { "sts:DurationSeconds" = 300 }
        }
      },
      ], var.routekit.auth_mode == "secrets_manager" ? [{
        Sid      = "ReadRotatingRouteKitSecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.routekit.secret_arn
        }] : [], local.is_pool ? [{
        Sid    = "CompleteOwnLifecycleAction"
        Effect = "Allow"
        Action = [
          "autoscaling:CompleteLifecycleAction",
          "autoscaling:RecordLifecycleActionHeartbeat"
        ]
        Resource = "*"
        Condition = {
          StringEquals = { "autoscaling:ResourceTag/routekit:trust-domain" = var.trust_domain }
        }
    }] : [])
  })
}

resource "aws_iam_role_policy_attachment" "workload" {
  for_each   = toset(var.workload_policy_arns)
  role       = aws_iam_role.runtime.name
  policy_arn = each.value
}
