variable "aws_region" {
  description = "AWS region. The v1 topology is intentionally Oregon-only."
  type        = string
  default     = "us-west-2"

  validation {
    condition     = var.aws_region == "us-west-2"
    error_message = "This stack supports only us-west-2."
  }
}

variable "aws_profile" {
  description = "Credential-process profile backed by the temporary aws login session."
  type        = string
}

variable "name_prefix" {
  description = "Short name used for AWS resources and tags."
  type        = string
  default     = "routekit-prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, numbers, or hyphens."
  }
}

variable "availability_zones" {
  description = "Exactly three Oregon AZs used by the public subnets."
  type        = list(string)
  default     = ["us-west-2a", "us-west-2b", "us-west-2c"]

  validation {
    condition     = var.availability_zones == tolist(["us-west-2a", "us-west-2b", "us-west-2c"])
    error_message = "availability_zones must be us-west-2a, us-west-2b, and us-west-2c in order."
  }
}

variable "vpc_cidr" {
  description = "CIDR for the deployment VPC."
  type        = string
  default     = "10.42.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be valid IPv4 CIDR notation."
  }
}

variable "existing_network" {
  description = "Optional existing VPC and one public subnet per required AZ. Leave null to create the dedicated network."
  type = object({
    vpc_id            = string
    public_subnet_ids = map(string)
  })
  default  = null
  nullable = true

  validation {
    condition = var.existing_network == null || (
      can(regex("^vpc-[0-9a-f]+$", var.existing_network.vpc_id)) &&
      toset(keys(var.existing_network.public_subnet_ids)) == toset(var.availability_zones) &&
      alltrue([for id in values(var.existing_network.public_subnet_ids) : can(regex("^subnet-[0-9a-f]+$", id))])
    )
    error_message = "existing_network must provide a VPC ID and exactly one subnet ID for each required availability zone."
  }
}

variable "gateway_instance_type" {
  description = "EC2 instance type for both RouteKit gateways."
  type        = string
  default     = "t3.medium"

  validation {
    condition     = can(regex("^[a-z][a-z0-9.]+$", var.gateway_instance_type))
    error_message = "gateway_instance_type must be a valid EC2 instance type."
  }
}

variable "t3_instance_type" {
  description = "EC2 instance type for both T3 hosts."
  type        = string
  default     = "m7i.xlarge"

  validation {
    condition     = can(regex("^[a-z][a-z0-9.]+$", var.t3_instance_type))
    error_message = "t3_instance_type must be a valid EC2 instance type."
  }
}

variable "t3_home_volume_size_gib" {
  description = "Size of each persistent T3 home EBS volume."
  type        = number
  default     = 200

  validation {
    condition     = var.t3_home_volume_size_gib >= 200 && var.t3_home_volume_size_gib <= 16384
    error_message = "t3_home_volume_size_gib must be between 200 and 16384 GiB."
  }
}

variable "node_version" {
  type        = string
  description = "Exact Node.js version installed on every node."
  default     = "22.22.2"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.node_version))
    error_message = "node_version must be an exact semver release."
  }
}

variable "routekit_version" {
  type        = string
  description = "Exact @velum-labs/routekit version installed on every node."
  default     = "0.18.2"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.routekit_version))
    error_message = "routekit_version must be an exact semver release."
  }
}

variable "efs_utils_version" {
  type        = string
  description = "Exact AmazonEFSUtils package version installed on gateway nodes through SSM Distributor."
  default     = "3.2.0-1"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+-[0-9]+$", var.efs_utils_version))
    error_message = "efs_utils_version must be an exact package version such as 3.2.0-1."
  }
}

variable "t3_version" {
  type        = string
  description = "Exact T3 version installed on T3 nodes."
  default     = "0.0.31"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.t3_version))
    error_message = "t3_version must be an exact semver release."
  }
}

variable "codex_version" {
  type        = string
  description = "Exact @openai/codex version installed on every node."
  default     = "0.146.0"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.codex_version))
    error_message = "codex_version must be an exact semver release."
  }
}

variable "claude_code_version" {
  type        = string
  description = "Exact @anthropic-ai/claude-code version installed on every node."
  default     = "2.1.222"

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+$", var.claude_code_version))
    error_message = "claude_code_version must be an exact semver release."
  }
}

variable "routekit_uid" {
  description = "Fixed UID/GID used by the non-human RouteKit account on both gateways."
  type        = number
  default     = 973

  validation {
    condition     = var.routekit_uid >= 900 && var.routekit_uid <= 999
    error_message = "routekit_uid must be a reserved system UID from 900 through 999."
  }
}

variable "admin_user" {
  description = "Node-local primary administrator account created on every node."
  type        = string
  default     = "alice"

  validation {
    condition     = can(regex("^[a-z_][a-z0-9_-]{0,31}$", var.admin_user)) && var.admin_user != "root"
    error_message = "admin_user must be a safe non-root Linux username."
  }
}

variable "operator_users" {
  description = "Node-local gateway peer accounts. Values are nonsecret Linux usernames."
  type        = list(string)
  default     = ["alice", "bob"]

  validation {
    condition = (
      length(var.operator_users) >= 1 &&
      length(distinct(var.operator_users)) == length(var.operator_users) &&
      alltrue([for name in var.operator_users : can(regex("^[a-z_][a-z0-9_-]{0,31}$", name)) && name != "root"])
    )
    error_message = "operator_users must contain one or more distinct, safe non-root Linux usernames."
  }
}

variable "t3_nodes" {
  description = "Persistent T3 node slots keyed by deployment-chosen logical names."
  type = map(object({
    availability_zone = string
    service_user      = string
    tailscale = object({
      client_id = string
      audience  = string
      tag       = string
    })
  }))
  default = {
    t3-a = {
      availability_zone = "us-west-2b"
      service_user      = "alice"
      tailscale = {
        client_id = "TSAILCLIENTIDFOUNDERAEXAMPLE"
        audience  = "api.tailscale.com/TSAILCLIENTIDFOUNDERAEXAMPLE"
        tag       = "tag:t3-a"
      }
    }
    t3-b = {
      availability_zone = "us-west-2c"
      service_user      = "bob"
      tailscale = {
        client_id = "TSAILCLIENTIDFOUNDERBEXAMPLE"
        audience  = "api.tailscale.com/TSAILCLIENTIDFOUNDERBEXAMPLE"
        tag       = "tag:t3-b"
      }
    }
  }

  validation {
    condition = (
      length(var.t3_nodes) >= 1 &&
      length(distinct([for node in values(var.t3_nodes) : node.service_user])) == length(var.t3_nodes) &&
      alltrue([
        for name, node in var.t3_nodes :
        can(regex("^t3-[a-z0-9][a-z0-9-]{0,27}$", name)) &&
        contains(["us-west-2a", "us-west-2b", "us-west-2c"], node.availability_zone) &&
        can(regex("^[a-z_][a-z0-9_-]{0,31}$", node.service_user)) && node.service_user != "root" &&
        can(regex("^[A-Za-z0-9_-]{16,128}$", node.tailscale.client_id)) &&
        node.tailscale.audience == "api.tailscale.com/${node.tailscale.client_id}" &&
        can(regex("^tag:[a-z][a-z0-9-]{1,62}$", node.tailscale.tag))
      ])
    )
    error_message = "t3_nodes must define one or more generic slots with distinct safe users, Oregon AZs, and exact Tailscale identities."
  }
}

variable "tailscale" {
  description = "Nonsecret workload federation settings created in the company tailnet."
  type = object({
    tailnet_dns_name = string
    gateway = object({
      client_id = string
      audience  = string
    })
  })
  sensitive = true

  validation {
    condition = (
      can(regex("^[a-z0-9-]+\\.ts\\.net$", var.tailscale.tailnet_dns_name)) &&
      can(regex("^[A-Za-z0-9_-]{16,128}$", var.tailscale.gateway.client_id)) &&
      var.tailscale.gateway.audience == "api.tailscale.com/${var.tailscale.gateway.client_id}"
    )
    error_message = "Use a valid *.ts.net DNS name and each generated client ID with its exact api.tailscale.com/<client-id> audience."
  }
}

variable "tags" {
  description = "Additional tags applied to every AWS resource that supports them."
  type        = map(string)
  default = {
    Environment = "production"
    Repository  = "velum-labs/routekit"
  }
}
