locals {
  create_network = var.existing_network == null

  subnet_cidrs = {
    for index, az in var.availability_zones : az => cidrsubnet(var.vpc_cidr, 8, index)
  }


  vpc_id = local.create_network ? aws_vpc.main[0].id : var.existing_network.vpc_id
  public_subnet_ids = local.create_network ? {
    for az, subnet in aws_subnet.public : az => subnet.id
  } : var.existing_network.public_subnet_ids

  gateway_nodes_config = {
    gateway-a = {
      kind          = "gateway"
      az            = var.availability_zones[0]
      instance_type = var.gateway_instance_type
      identity      = "gateway"
      ts_tag        = "tag:routekit-gateway"
      service_user  = "routekit"
      active        = true
    }
    gateway-b = {
      kind          = "gateway"
      az            = var.availability_zones[1]
      instance_type = var.gateway_instance_type
      identity      = "gateway"
      ts_tag        = "tag:routekit-gateway"
      service_user  = "routekit"
      active        = false
    }
  }

  t3_nodes_config = {
    for name, node in var.t3_nodes : name => {
      kind          = "t3"
      az            = node.availability_zone
      instance_type = var.t3_instance_type
      identity      = name
      ts_tag        = node.tailscale.tag
      service_user  = node.service_user
      active        = false
    }
  }

  nodes = merge(local.gateway_nodes_config, local.t3_nodes_config)

  gateway_nodes = { for name, node in local.nodes : name => node if node.kind == "gateway" }
  t3_nodes      = { for name, node in local.nodes : name => node if node.kind == "t3" }

  workload_identities = merge({
    gateway = {
      audience = var.tailscale.gateway.audience
    }
  }, { for name, node in var.t3_nodes : name => { audience = node.tailscale.audience } })

  tailscale_clients = merge(
    { gateway = var.tailscale.gateway },
    { for name, node in var.t3_nodes : name => node.tailscale }
  )
}
