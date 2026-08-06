output "kms_key_arn" { value = aws_kms_key.credentials.arn }
output "kms_key_id" { value = aws_kms_key.credentials.key_id }
output "config_parameter_name" { value = aws_ssm_parameter.config.name }
output "verifier_config_parameter_name" { value = aws_ssm_parameter.verifier_config.name }
output "broker_contract" {
  value = {
    aws_audience      = var.aws_audience
    aws_issuers       = local.normalized_aws_issuers
    routekit_issuer   = var.routekit_issuer
    routekit_audience = var.routekit_audience
    kms_key_arn       = aws_kms_key.credentials.arn
  }
}
