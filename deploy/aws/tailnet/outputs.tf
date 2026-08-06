output "workload_identities" {
  description = "Nonsecret values to copy into the AWS stack tailscale input."
  value = {
    for name, identity in tailscale_federated_identity.aws : name => {
      client_id = identity.id
      audience  = identity.audience
    }
  }
}

output "gateway_service" {
  value = {
    name  = tailscale_service.routekit_gateway.name
    addrs = tailscale_service.routekit_gateway.addrs
  }
}

output "credential_service" {
  value = {
    name  = tailscale_service.routekit_credentials.name
    addrs = tailscale_service.routekit_credentials.addrs
  }
}

output "factory_control_service" {
  value = var.factory_services_enabled ? {
    name  = tailscale_service.factory_control[0].name
    addrs = tailscale_service.factory_control[0].addrs
  } : null
}

output "factory_public_worker_service" {
  value = var.factory_services_enabled ? {
    name  = tailscale_service.factory_worker_public[0].name
    addrs = tailscale_service.factory_worker_public[0].addrs
  } : null
}
