data "aws_caller_identity" "current" {}

resource "aws_kms_key" "runtime" {
  description             = "${var.trust_domain} isolated runtime and home storage"
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

resource "aws_ebs_snapshot_copy" "home" {
  count = var.home_provisioned && var.source_snapshot_id != null ? 1 : 0

  description        = "${var.trust_domain} home migration encrypted into its isolated KMS boundary"
  source_snapshot_id = var.source_snapshot_id
  source_region      = var.source_snapshot_region
  encrypted          = true
  kms_key_id         = aws_kms_key.runtime.arn
  tags               = merge(var.tags, { Name = "${var.name}-home-migration", Backup = "required" })

  lifecycle { prevent_destroy = true }
}

module "runtime" {
  source = "../modules/t3-routekit-runtime"

  mode           = "personal"
  name           = var.name
  environment    = var.environment
  trust_domain   = var.trust_domain
  region         = var.region
  vpc_id         = var.vpc_id
  subnet_ids     = var.subnet_ids
  ami            = var.ami
  instance_types = ["m7i.xlarge"]
  personal = {
    subnet_id      = var.personal_subnet_id
    service_user   = var.service_user
    enabled        = var.instance_enabled
    provision_home = var.home_provisioned
  }
  root_volume = {
    size_gib = 40, type = "gp3", encrypted = true, kms_key_arn = aws_kms_key.runtime.arn, delete_on_termination = true
  }
  home_volume = {
    size_gib    = var.home_size_gib
    type        = "gp3"
    kms_key_arn = aws_kms_key.runtime.arn
    snapshot_id = var.home_provisioned && var.source_snapshot_id != null ? aws_ebs_snapshot_copy.home[0].id : null
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

resource "aws_backup_vault" "home" {
  name        = "${var.name}-home"
  kms_key_arn = aws_kms_key.runtime.arn
  tags        = var.tags
}

resource "aws_iam_role" "backup" {
  name_prefix        = "${var.name}-backup-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "backup.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_plan" "home" {
  name = "${var.name}-home"
  rule {
    rule_name         = "four-hour"
    target_vault_name = aws_backup_vault.home.name
    schedule          = "cron(0 0/4 * * ? *)"
    lifecycle { delete_after = 14 }
  }
  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.home.name
    schedule          = "cron(0 5 * * ? *)"
    lifecycle { delete_after = 30 }
  }
  tags = var.tags
}

resource "aws_backup_selection" "home" {
  count = var.home_provisioned ? 1 : 0

  name         = "${var.name}-home"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.home.id
  resources    = ["arn:aws:ec2:${var.region}:${data.aws_caller_identity.current.account_id}:volume/${module.runtime.personal_home_volume_id}"]
}
