resource "aws_cloudwatch_metric_alarm" "recover" {
  for_each = aws_instance.node

  alarm_name          = "${var.name_prefix}-${each.key}-system-status"
  alarm_description   = "Recover ${each.key} after a failed EC2 system status check"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = ["arn:aws:automate:${var.aws_region}:ec2:recover"]

  dimensions = { InstanceId = each.value.id }
}

resource "aws_cloudwatch_metric_alarm" "instance_status" {
  for_each = aws_instance.node

  alarm_name          = "${var.name_prefix}-${each.key}-instance-status"
  alarm_description   = "Detect an operating-system-level EC2 instance status failure on ${each.key}"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_Instance"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"

  dimensions = { InstanceId = each.value.id }
}
