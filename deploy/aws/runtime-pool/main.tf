data "aws_caller_identity" "current" {}

resource "aws_kms_key" "runtime" {
  description             = "${var.trust_domain} isolated ephemeral runtime storage"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableAccountIAM", Effect = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*", Resource = "*"
      },
      {
        Sid       = "AllowRuntimeLogEncryption", Effect = "Allow"
        Principal = { Service = "logs.${var.region}.amazonaws.com" }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource  = "*"
        Condition = {
          ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/routekit/runtime/${var.trust_domain}/*" }
        }
      }
    ]
  })
  tags = merge(var.tags, { Name = "${var.name}-runtime" })
  lifecycle { prevent_destroy = true }
}

resource "aws_kms_alias" "runtime" {
  name          = "alias/${var.name}-runtime"
  target_key_id = aws_kms_key.runtime.key_id
}

resource "aws_cloudwatch_event_bus" "lifecycle" {
  name = "${var.name}-lifecycle"
  tags = var.tags
}

locals {
  autoscaling_service_role_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling"
}

resource "aws_kms_grant" "autoscaling_runtime" {
  name              = "${var.name}-runtime"
  key_id            = aws_kms_key.runtime.arn
  grantee_principal = local.autoscaling_service_role_arn
  operations = [
    "Encrypt", "Decrypt", "ReEncryptFrom", "ReEncryptTo", "GenerateDataKeyWithoutPlaintext",
    "DescribeKey", "CreateGrant"
  ]
}

resource "aws_kms_grant" "autoscaling_image" {
  name              = "${var.name}-image"
  key_id            = var.ami.image_kms_key_arn
  grantee_principal = local.autoscaling_service_role_arn
  operations = [
    "Decrypt", "ReEncryptFrom", "DescribeKey", "CreateGrant"
  ]
}

module "runtime" {
  source = "../modules/t3-routekit-runtime"

  mode           = "pool"
  name           = var.name
  environment    = var.environment
  trust_domain   = var.trust_domain
  region         = var.region
  vpc_id         = var.vpc_id
  subnet_ids     = var.subnet_ids
  ami            = var.ami
  instance_types = var.instance_types
  capacity       = var.capacity
  root_volume = {
    size_gib = 200, type = "gp3", encrypted = true, kms_key_arn = aws_kms_key.runtime.arn, delete_on_termination = true
  }
  routekit = {
    endpoint                   = var.routekit_endpoint
    principal                  = var.routekit_principal
    auth_mode                  = "credential_broker"
    credential_broker_ref      = var.routekit_broker_ref
    credential_broker_url      = var.routekit_broker_url
    credential_broker_audience = var.routekit_broker_audience
    routing_policy_version     = var.routekit_policy_version
  }
  tailscale = {
    enabled                     = true
    tags                        = [var.tailscale_tag]
    workload_identity_client_id = var.tailscale_client_id
    workload_identity_audience  = var.tailscale_audience
    manage_tailnet_policy       = false
  }
  runtime_lifecycle = {
    launch_before_terminate = true
    instance_warmup_seconds = 180
    launch_timeout_seconds  = 900
    drain_timeout_seconds   = 86400
    event_bus_arn           = aws_cloudwatch_event_bus.lifecycle.arn
    auto_rollback           = true
    capacity_rebalance      = false
  }
  observability = {
    log_retention_days  = 30
    alarm_topic_arns    = var.alarm_topic_arns
    detailed_monitoring = true
  }
  egress_rules = [
    { description = "HTTPS through caller NAT", protocol = "tcp", from_port = 443, to_port = 443, cidr_blocks = ["0.0.0.0/0"] },
    { description = "VPC DNS UDP", protocol = "udp", from_port = 53, to_port = 53, cidr_blocks = [var.vpc_cidr] },
    { description = "VPC DNS TCP", protocol = "tcp", from_port = 53, to_port = 53, cidr_blocks = [var.vpc_cidr] },
    { description = "Amazon Time Sync", protocol = "udp", from_port = 123, to_port = 123, cidr_blocks = ["169.254.169.123/32"] }
  ]
  tags = var.tags
}
