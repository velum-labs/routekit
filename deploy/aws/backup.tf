resource "aws_backup_vault" "main" {
  name        = "${var.name_prefix}-backups"
  kms_key_arn = aws_kms_key.data.arn
}

resource "aws_iam_role" "backup" {
  name = "${var.name_prefix}-backup"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "backup.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_backup_plan" "t3" {
  name = "${var.name_prefix}-t3-home"

  rule {
    rule_name         = "every-four-hours"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(0 0/4 * * ? *)"

    lifecycle { delete_after = 14 }
  }

  rule {
    rule_name         = "daily-thirty-days"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(30 5 * * ? *)"

    lifecycle { delete_after = 30 }
  }
}

resource "aws_backup_selection" "t3" {
  name         = "${var.name_prefix}-t3-home"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.t3.id

  selection_tag {
    type  = "STRINGEQUALS"
    key   = "BackupClass"
    value = "T3Home"
  }
}

resource "aws_backup_plan" "efs" {
  name = "${var.name_prefix}-efs"

  rule {
    rule_name         = "daily-thirty-days"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(0 6 * * ? *)"

    lifecycle { delete_after = 30 }
  }
}

resource "aws_backup_selection" "efs" {
  name         = "${var.name_prefix}-efs"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.efs.id

  selection_tag {
    type  = "STRINGEQUALS"
    key   = "BackupClass"
    value = "RouteKitEFS"
  }
}
