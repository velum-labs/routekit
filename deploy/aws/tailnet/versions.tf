terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  required_providers {
    tailscale = {
      source  = "tailscale/tailscale"
      version = "~> 0.29.0"
    }
  }

  backend "s3" {}
}

provider "tailscale" {
  tailnet = var.tailnet_id
  # Authentication is intentionally environment-only. Bootstrap with a
  # short-lived TAILSCALE_API_KEY; it is never passed to Terraform inputs.
}
