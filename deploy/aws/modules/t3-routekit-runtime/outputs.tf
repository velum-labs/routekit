output "autoscaling_group_name" {
  value = local.is_pool ? aws_autoscaling_group.pool[0].name : null
}

output "autoscaling_group_arn" {
  value = local.is_pool ? aws_autoscaling_group.pool[0].arn : null
}

output "launch_template_id" {
  value = local.is_pool ? aws_launch_template.pool[0].id : null
}

output "launch_template_version" {
  value = local.is_pool ? aws_launch_template.pool[0].latest_version : null
}

output "personal_instance_id" {
  value = local.personal_enabled ? aws_instance.personal[0].id : null
}

output "personal_home_volume_id" {
  value = local.personal_home_enabled ? aws_ebs_volume.home[0].id : null
}

output "instance_role_name" {
  value = aws_iam_role.runtime.name
}

output "instance_role_arn" {
  value = aws_iam_role.runtime.arn
}

output "security_group_id" {
  value = aws_security_group.runtime.id
}

output "log_group_names" {
  value = sort([for group in aws_cloudwatch_log_group.runtime : group.name])
}

output "alarm_arns" {
  value = concat(
    [for alarm in aws_cloudwatch_metric_alarm.runtime : alarm.arn],
    aws_cloudwatch_metric_alarm.pool_capacity[*].arn,
    [for alarm in aws_cloudwatch_metric_alarm.personal_status : alarm.arn]
  )
}

output "launch_lifecycle_hook_name" {
  value = local.is_pool ? aws_autoscaling_lifecycle_hook.launch[0].name : null
}

output "termination_lifecycle_hook_name" {
  value = local.is_pool ? aws_autoscaling_lifecycle_hook.termination[0].name : null
}

output "runtime_identity" {
  value = merge(local.identity, {
    module_contract_version = "1.2.0"
    release_fingerprint     = local.release_fingerprint
  })
}

output "ssm_resource_tag_query" {
  value = "tag:routekit:trust-domain=${var.trust_domain}"
}

output "bootstrap_parameter_arn" {
  value = aws_ssm_parameter.bootstrap.arn
}

output "dashboard_name" {
  value = aws_cloudwatch_dashboard.runtime.dashboard_name
}
