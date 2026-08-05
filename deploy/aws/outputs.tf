output "instances" {
  description = "Nonsecret inventory for SSM and failover operations."
  value = {
    for name, instance in aws_instance.node : name => {
      id         = instance.id
      private_ip = instance.private_ip
      public_ip  = instance.public_ip
      az         = instance.availability_zone
    }
  }
}

output "network" {
  description = "VPC and subnet inventory used by the deployment."
  value = {
    vpc_id            = local.vpc_id
    public_subnet_ids = local.public_subnet_ids
    managed           = local.create_network
  }
}

output "routekit_efs_id" {
  value = aws_efs_file_system.routekit.id
}

output "active_gateway_parameter" {
  value = aws_ssm_parameter.active_gateway.name
}

output "gateway_service_url" {
  value     = "https://routekit-gateway.${var.tailscale.tailnet_dns_name}"
  sensitive = true
}

output "t3_urls" {
  value     = { for name, _ in var.t3_nodes : name => "https://${var.name_prefix}-${name}.${var.tailscale.tailnet_dns_name}" }
  sensitive = true
}
