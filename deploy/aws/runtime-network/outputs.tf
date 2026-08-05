output "private_subnet_ids" {
  value = { for az, subnet in aws_subnet.private : az => subnet.id }
}
output "endpoint_security_group_id" { value = aws_security_group.endpoints.id }
output "nat_gateway_ids" { value = { for az, nat in aws_nat_gateway.az : az => nat.id } }
