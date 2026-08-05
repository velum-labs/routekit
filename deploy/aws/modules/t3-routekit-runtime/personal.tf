resource "aws_ebs_volume" "home" {
  count = local.personal_home_enabled ? 1 : 0

  availability_zone = data.aws_subnet.runtime[local.personal_subnet_id].availability_zone
  size              = var.home_volume.size_gib
  type              = var.home_volume.type
  encrypted         = true
  kms_key_id        = var.home_volume.kms_key_arn
  iops              = var.home_volume.iops
  throughput        = var.home_volume.throughput
  snapshot_id       = var.home_volume.snapshot_id
  tags              = merge(local.common_tags, { Name = "${var.name}-home", Backup = "required" })

  lifecycle {
    prevent_destroy = true
    # A restored personal home is persistent state. Once the volume exists,
    # changing the migration source must never replace it or risk data loss.
    ignore_changes = [snapshot_id]
  }
}

resource "aws_instance" "personal" {
  count = local.personal_enabled ? 1 : 0

  ami                         = var.ami.id
  instance_type               = var.instance_types[0]
  subnet_id                   = local.personal_subnet_id
  vpc_security_group_ids      = local.security_group_ids
  iam_instance_profile        = aws_iam_instance_profile.runtime.name
  associate_public_ip_address = false
  monitoring                  = var.observability.detailed_monitoring
  disable_api_termination     = var.personal.disable_api_termination
  key_name                    = null

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  root_block_device {
    volume_type           = var.root_volume.type
    volume_size           = var.root_volume.size_gib
    encrypted             = true
    kms_key_id            = var.root_volume.kms_key_arn
    delete_on_termination = var.root_volume.delete_on_termination
    iops                  = var.root_volume.iops
    throughput            = var.root_volume.throughput
  }

  tags = merge(local.common_tags, {
    "routekit:bootstrap-parameter" = aws_ssm_parameter.bootstrap.name
    "routekit:home-volume"         = aws_ebs_volume.home[0].id
  })

  depends_on = [terraform_data.contract, aws_iam_role_policy.runtime]

  lifecycle {
    create_before_destroy = true
    replace_triggered_by  = [terraform_data.contract]
  }
}

resource "aws_volume_attachment" "home" {
  count = local.personal_enabled ? 1 : 0

  device_name                    = var.personal.home_device_name
  volume_id                      = aws_ebs_volume.home[0].id
  instance_id                    = aws_instance.personal[0].id
  force_detach                   = false
  stop_instance_before_detaching = var.personal.stop_instance_before_detach
}
