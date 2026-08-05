resource "aws_kms_key" "data" {
  description             = "RouteKit production EFS, EBS, and backup encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = { Name = "${var.name_prefix}-data" }

  lifecycle { prevent_destroy = true }
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name_prefix}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_efs_file_system" "routekit" {
  encrypted        = true
  kms_key_id       = aws_kms_key.data.arn
  performance_mode = "generalPurpose"
  throughput_mode  = "elastic"

  lifecycle_policy { transition_to_ia = "AFTER_30_DAYS" }

  tags = {
    Name        = "${var.name_prefix}-routekit-state"
    BackupClass = "RouteKitEFS"
  }

  lifecycle { prevent_destroy = true }
}

resource "aws_efs_mount_target" "routekit" {
  for_each = local.public_subnet_ids

  file_system_id  = aws_efs_file_system.routekit.id
  subnet_id       = each.value
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "state" {
  file_system_id = aws_efs_file_system.routekit.id

  posix_user {
    uid = var.routekit_uid
    gid = var.routekit_uid
  }

  root_directory {
    path = "/state"
    creation_info {
      owner_uid = var.routekit_uid
      owner_gid = var.routekit_uid
      # Peer accounts traverse only the daemon's public record. Secret
      # subdirectories remain RouteKit-owned 0700/0600.
      permissions = "0711"
    }
  }

  tags = { Name = "${var.name_prefix}-state" }
}

resource "aws_efs_access_point" "config" {
  file_system_id = aws_efs_file_system.routekit.id

  posix_user {
    uid = var.routekit_uid
    gid = var.routekit_uid
  }

  root_directory {
    path = "/config"
    creation_info {
      owner_uid   = var.routekit_uid
      owner_gid   = var.routekit_uid
      permissions = "0700"
    }
  }

  tags = { Name = "${var.name_prefix}-config" }
}

resource "aws_ebs_volume" "t3_home" {
  for_each = local.t3_nodes

  availability_zone = each.value.az
  size              = var.t3_home_volume_size_gib
  type              = "gp3"
  encrypted         = true
  kms_key_id        = aws_kms_key.data.arn

  tags = {
    Name        = "${var.name_prefix}-${each.key}-home"
    BackupClass = "T3Home"
    Node        = each.key
  }

  lifecycle { prevent_destroy = true }
}
