data "aws_vpc" "runtime" { id = var.vpc_id }

resource "aws_subnet" "private" {
  for_each = var.private_subnet_cidrs

  vpc_id                  = var.vpc_id
  availability_zone       = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-${each.key}-private", Network = "private" }

  lifecycle {
    precondition {
      condition     = data.aws_vpc.runtime.cidr_block == var.vpc_cidr
      error_message = "vpc_cidr must match the existing VPC."
    }
  }
}

resource "aws_eip" "nat" {
  for_each = var.private_subnet_cidrs
  domain   = "vpc"
  tags     = { Name = "${var.name}-${each.key}-nat" }
}

resource "aws_nat_gateway" "az" {
  for_each = var.private_subnet_cidrs

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = var.public_subnet_ids[each.key]
  tags          = { Name = "${var.name}-${each.key}" }
}

resource "aws_route_table" "private" {
  for_each = var.private_subnet_cidrs
  vpc_id   = var.vpc_id
  tags     = { Name = "${var.name}-${each.key}-private" }
}

resource "aws_route" "nat" {
  for_each = var.private_subnet_cidrs

  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.az[each.key].id
}

resource "aws_route_table_association" "private" {
  for_each = var.private_subnet_cidrs

  subnet_id      = aws_subnet.private[each.key].id
  route_table_id = aws_route_table.private[each.key].id
}

resource "aws_security_group" "endpoints" {
  name_prefix = "${var.name}-endpoints-"
  description = "Private runtime access to AWS interface endpoints"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-endpoints" }
  lifecycle { create_before_destroy = true }
}

resource "aws_vpc_security_group_ingress_rule" "endpoint_https" {
  security_group_id = aws_security_group.endpoints.id
  description       = "HTTPS from resources inside the caller VPC"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "endpoint_return" {
  security_group_id = aws_security_group.endpoints.id
  description       = "Stateful endpoint return traffic"
  ip_protocol       = "-1"
  cidr_ipv4         = var.vpc_cidr
}

locals {
  interface_services = toset([
    "autoscaling", "ec2", "ec2messages", "kms", "logs", "monitoring",
    "secretsmanager", "ssm", "ssmmessages", "sts"
  ])
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_services

  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [for subnet in aws_subnet.private : subnet.id]
  security_group_ids  = [aws_security_group.endpoints.id]
  tags                = { Name = "${var.name}-${each.value}" }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = var.vpc_id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for table in aws_route_table.private : table.id]
  tags              = { Name = "${var.name}-s3" }
}
