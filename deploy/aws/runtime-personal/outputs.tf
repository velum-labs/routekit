output "instance_id" { value = module.runtime.personal_instance_id }
output "home_volume_id" { value = module.runtime.personal_home_volume_id }
output "runtime_identity" { value = module.runtime.runtime_identity }
output "ssm_resource_tag_query" { value = module.runtime.ssm_resource_tag_query }
output "instance_role_name" { value = module.runtime.instance_role_name }
output "instance_role_arn" { value = module.runtime.instance_role_arn }
output "security_group_id" { value = module.runtime.security_group_id }
