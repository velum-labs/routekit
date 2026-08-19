data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_instance" "node" {
  for_each = local.nodes

  ami                         = data.aws_ami.ubuntu.id
  instance_type               = each.value.instance_type
  availability_zone           = each.value.az
  subnet_id                   = local.public_subnet_ids[each.value.az]
  vpc_security_group_ids      = [each.value.kind == "gateway" ? aws_security_group.gateway.id : aws_security_group.t3.id]
  iam_instance_profile        = aws_iam_instance_profile.workload[each.value.identity].name
  associate_public_ip_address = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  root_block_device {
    encrypted   = true
    kms_key_id  = aws_kms_key.data.arn
    volume_type = "gp3"
    volume_size = each.value.kind == "gateway" ? 30 : 40
  }

  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/templates/node.sh.tftpl", {
    node_name                   = "${var.name_prefix}-${each.key}"
    node_kind                   = each.value.kind
    node_version                = var.node_version
    routekit_version            = var.routekit_version
    t3_version                  = var.t3_version
    codex_version               = var.codex_version
    claude_code_version         = var.claude_code_version
    routekit_uid                = var.routekit_uid
    admin_user                  = var.admin_user
    routekit_active             = each.value.active
    operator_users              = join(" ", var.operator_users)
    service_user                = each.value.service_user
    tailscale_client_id         = local.tailscale_clients[each.value.identity].client_id
    tailscale_audience          = local.tailscale_clients[each.value.identity].audience
    tailscale_tag               = each.value.ts_tag
    efs_id                      = each.value.kind == "gateway" ? aws_efs_file_system.routekit.id : ""
    efs_state_access_point      = each.value.kind == "gateway" ? aws_efs_access_point.state.id : ""
    efs_config_access_point     = each.value.kind == "gateway" ? aws_efs_access_point.config.id : ""
    t3_home_volume_id           = each.value.kind == "t3" ? aws_ebs_volume.t3_home[each.key].id : ""
    t3_home_volume_compact      = each.value.kind == "t3" ? replace(aws_ebs_volume.t3_home[each.key].id, "-", "") : ""
    aws_region                  = var.aws_region
    nginx_routekit_location_b64 = base64encode(file("${path.module}/templates/nginx-routekit-tailnet-location.conf"))
  })

  tags = {
    Name     = "${var.name_prefix}-${each.key}"
    Node     = each.key
    Role     = each.value.kind
    TailTag  = each.value.ts_tag
    Failover = each.value.kind == "gateway" ? "routekit-gateway" : "none"
  }

  depends_on = [aws_efs_mount_target.routekit]
}

resource "aws_volume_attachment" "t3_home" {
  for_each = local.t3_nodes

  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.t3_home[each.key].id
  instance_id = aws_instance.node[each.key].id
}

resource "aws_ssm_parameter" "active_gateway" {
  name        = "/${var.name_prefix}/active-gateway"
  description = "Operator-visible active RouteKit gateway marker"
  type        = "String"
  value       = "a"

  lifecycle { ignore_changes = [value] }
}
