output "autoscaling_group_name" { value = module.runtime.autoscaling_group_name }
output "launch_template_id" { value = module.runtime.launch_template_id }
output "launch_template_version" { value = module.runtime.launch_template_version }
output "runtime_identity" { value = module.runtime.runtime_identity }
output "lifecycle_event_bus_arn" { value = aws_cloudwatch_event_bus.lifecycle.arn }
