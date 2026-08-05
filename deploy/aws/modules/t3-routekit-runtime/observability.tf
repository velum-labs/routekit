resource "aws_cloudwatch_log_group" "runtime" {
  for_each = toset(["supervisor", "t3", "routekit-connector", "cloud-init"])

  name              = "/routekit/runtime/${var.trust_domain}/${each.value}"
  retention_in_days = var.observability.log_retention_days
  kms_key_id        = var.root_volume.kms_key_arn
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_subscription_filter" "central" {
  for_each = var.observability.central_log_destination_arn == null ? {} : aws_cloudwatch_log_group.runtime

  name            = "central"
  log_group_name  = each.value.name
  filter_pattern  = ""
  destination_arn = var.observability.central_log_destination_arn
}

locals {
  custom_alarms = {
    missing-heartbeat = { metric = "Heartbeat", threshold = 1, comparison = "LessThanThreshold", periods = 3 }
    disk-pressure     = { metric = "DiskUsedPercent", threshold = 85, comparison = "GreaterThanOrEqualToThreshold", periods = 2 }
    t3-service        = { metric = "T3ServiceHealthy", threshold = 1, comparison = "LessThanThreshold", periods = 2 }
    routekit-service  = { metric = "RouteKitConnectorHealthy", threshold = 1, comparison = "LessThanThreshold", periods = 2 }
    manifest-invalid  = { metric = "ManifestValid", threshold = 1, comparison = "LessThanThreshold", periods = 1 }
  }
}

resource "aws_cloudwatch_metric_alarm" "runtime" {
  for_each = local.custom_alarms

  alarm_name          = "${var.name}-${each.key}"
  namespace           = "RouteKit/Runtime"
  metric_name         = each.value.metric
  dimensions          = { TrustDomain = var.trust_domain }
  statistic           = each.key == "disk-pressure" ? "Maximum" : "Minimum"
  period              = 60
  evaluation_periods  = each.value.periods
  datapoints_to_alarm = each.value.periods
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison
  treat_missing_data  = "breaching"
  alarm_actions       = var.observability.alarm_topic_arns
  ok_actions          = var.observability.alarm_topic_arns
  tags                = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "pool_capacity" {
  count = local.is_pool ? 1 : 0

  alarm_name          = "${var.name}-unhealthy-capacity"
  namespace           = "AWS/AutoScaling"
  metric_name         = "GroupInServiceInstances"
  dimensions          = { AutoScalingGroupName = aws_autoscaling_group.pool[0].name }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = local.capacity.desired == 0 ? 0 : local.capacity.desired
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = local.capacity.desired == 0 ? "notBreaching" : "breaching"
  alarm_actions       = var.observability.alarm_topic_arns
  ok_actions          = var.observability.alarm_topic_arns
  tags                = local.common_tags
}

resource "aws_cloudwatch_metric_alarm" "personal_status" {
  for_each = local.personal_enabled ? toset(["StatusCheckFailed_Instance", "StatusCheckFailed_System"]) : []

  alarm_name          = "${var.name}-${lower(replace(each.value, "_", "-"))}"
  namespace           = "AWS/EC2"
  metric_name         = each.value
  dimensions          = { InstanceId = aws_instance.personal[0].id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.observability.alarm_topic_arns
  ok_actions          = var.observability.alarm_topic_arns
  tags                = local.common_tags
}

resource "aws_cloudwatch_dashboard" "runtime" {
  dashboard_name = "${var.name}-${substr(local.release_fingerprint, 0, 8)}"
  dashboard_body = jsonencode({
    widgets = [{
      type = "metric"
      x    = 0, y = 0, width = 24, height = 8
      properties = {
        title  = "${var.name} runtime health"
        region = var.region
        period = 60
        metrics = [for key, alarm in local.custom_alarms : [
          "RouteKit/Runtime", alarm.metric, "TrustDomain", var.trust_domain
        ]]
      }
    }]
  })
}
