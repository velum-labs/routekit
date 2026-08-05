resource "aws_launch_template" "pool" {
  count = local.is_pool ? 1 : 0

  name_prefix            = "${var.name}-"
  image_id               = var.ami.id
  update_default_version = true
  vpc_security_group_ids = local.security_group_ids

  iam_instance_profile { name = aws_iam_instance_profile.runtime.name }
  monitoring { enabled = var.observability.detailed_monitoring }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_type           = var.root_volume.type
      volume_size           = var.root_volume.size_gib
      encrypted             = true
      kms_key_id            = var.root_volume.kms_key_arn
      delete_on_termination = var.root_volume.delete_on_termination
      iops                  = var.root_volume.iops
      throughput            = var.root_volume.throughput
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags = merge(local.common_tags, {
      "routekit:bootstrap-parameter" = aws_ssm_parameter.bootstrap.name
    })
  }
  tag_specifications {
    resource_type = "volume"
    tags          = local.common_tags
  }

  tags = local.common_tags

  depends_on = [terraform_data.contract, aws_iam_role_policy.runtime]

  lifecycle { create_before_destroy = true }
}

resource "aws_autoscaling_group" "pool" {
  count = local.is_pool ? 1 : 0

  name_prefix               = "${var.name}-"
  min_size                  = local.capacity.min
  desired_capacity          = local.capacity.desired
  max_size                  = local.capacity.max
  vpc_zone_identifier       = var.subnet_ids
  health_check_type         = "EC2"
  health_check_grace_period = var.runtime_lifecycle.instance_warmup_seconds
  default_instance_warmup   = var.runtime_lifecycle.instance_warmup_seconds
  capacity_rebalance        = var.runtime_lifecycle.capacity_rebalance
  max_instance_lifetime     = var.runtime_lifecycle.maximum_instance_lifetime_seconds
  force_delete              = false
  wait_for_capacity_timeout = "${var.runtime_lifecycle.launch_timeout_seconds}s"
  termination_policies      = ["OldestLaunchTemplate", "Default"]

  mixed_instances_policy {
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.pool[0].id
        version            = aws_launch_template.pool[0].latest_version
      }
      dynamic "override" {
        for_each = var.instance_types
        content { instance_type = override.value }
      }
    }
    instances_distribution {
      on_demand_base_capacity                  = local.capacity.purchase_model == "on_demand" ? local.capacity.desired : 0
      on_demand_percentage_above_base_capacity = local.capacity.purchase_model == "on_demand" ? 100 : 0
      spot_allocation_strategy                 = "price-capacity-optimized"
    }
  }

  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = var.runtime_lifecycle.launch_before_terminate ? 100 : 90
      max_healthy_percentage = var.runtime_lifecycle.launch_before_terminate ? 200 : 100
      instance_warmup        = var.runtime_lifecycle.instance_warmup_seconds
      auto_rollback          = var.runtime_lifecycle.auto_rollback
      skip_matching          = true
      alarm_specification {
        alarms = [for alarm in aws_cloudwatch_metric_alarm.runtime : alarm.alarm_name]
      }
    }
    triggers = ["launch_template"]
  }

  dynamic "tag" {
    for_each = merge(local.common_tags, {
      "routekit:bootstrap-parameter" = aws_ssm_parameter.bootstrap.name
      "routekit:drain-timeout"       = tostring(var.runtime_lifecycle.drain_timeout_seconds)
    })
    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }

  lifecycle { create_before_destroy = true }
}

resource "aws_autoscaling_lifecycle_hook" "launch" {
  count = local.is_pool ? 1 : 0

  name                   = "${var.name}-launch-readiness"
  autoscaling_group_name = aws_autoscaling_group.pool[0].name
  lifecycle_transition   = "autoscaling:EC2_INSTANCE_LAUNCHING"
  default_result         = "ABANDON"
  heartbeat_timeout      = min(var.runtime_lifecycle.launch_timeout_seconds, 7200)
  notification_metadata  = jsonencode({ trust_domain = var.trust_domain, action = "launch" })
}

resource "aws_autoscaling_lifecycle_hook" "termination" {
  count = local.is_pool ? 1 : 0

  name                   = "${var.name}-termination-drain"
  autoscaling_group_name = aws_autoscaling_group.pool[0].name
  lifecycle_transition   = "autoscaling:EC2_INSTANCE_TERMINATING"
  default_result         = "ABANDON"
  heartbeat_timeout      = min(var.runtime_lifecycle.drain_timeout_seconds, 7200)
  notification_metadata  = jsonencode({ trust_domain = var.trust_domain, action = "drain", approved_deadline_seconds = var.runtime_lifecycle.drain_timeout_seconds })
}

resource "aws_iam_role" "events" {
  count = local.is_pool ? 1 : 0

  name_prefix = "${var.name}-events-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Principal = { Service = "events.amazonaws.com" }, Action = "sts:AssumeRole"
    }]
  })
  tags = local.common_tags
}

resource "aws_iam_role_policy" "events" {
  count = local.is_pool ? 1 : 0

  name_prefix = "put-events-"
  role        = aws_iam_role.events[0].id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "events:PutEvents", Resource = var.runtime_lifecycle.event_bus_arn }]
  })
}

resource "aws_cloudwatch_event_rule" "lifecycle" {
  count = local.is_pool ? 1 : 0

  name_prefix = "${var.name}-lifecycle-"
  event_pattern = jsonencode({
    source      = ["aws.autoscaling"]
    detail-type = ["EC2 Instance-launch Lifecycle Action", "EC2 Instance-terminate Lifecycle Action"]
    detail      = { AutoScalingGroupName = [aws_autoscaling_group.pool[0].name] }
  })
  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "lifecycle" {
  count = local.is_pool ? 1 : 0

  rule     = aws_cloudwatch_event_rule.lifecycle[0].name
  arn      = var.runtime_lifecycle.event_bus_arn
  role_arn = aws_iam_role.events[0].arn
}
