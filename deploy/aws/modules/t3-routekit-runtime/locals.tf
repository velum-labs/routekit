data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_partition" "current" {}

data "aws_subnet" "runtime" {
  for_each = toset(var.subnet_ids)
  id       = each.value
}

data "aws_kms_key" "root" {
  key_id = var.root_volume.kms_key_arn
}

data "aws_kms_key" "manifest" {
  key_id = var.ami.manifest_kms_key_arn
}

data "aws_kms_key" "image" {
  key_id = var.ami.image_kms_key_arn
}

data "aws_kms_key" "home" {
  count  = var.mode == "personal" && var.home_volume != null ? 1 : 0
  key_id = var.home_volume.kms_key_arn
}

locals {
  is_personal = var.mode == "personal"
  is_pool     = var.mode == "pool"
  capacity = var.capacity == null ? {
    min = 0, desired = 0, max = 0, purchase_model = "on_demand"
  } : var.capacity
  personal_subnet_id    = var.personal == null ? null : var.personal.subnet_id
  personal_enabled      = local.is_personal && var.personal != null ? var.personal.enabled : false
  personal_home_enabled = local.is_personal && var.personal != null ? var.personal.provision_home : false
  subnet_azs            = distinct([for subnet in data.aws_subnet.runtime : subnet.availability_zone])
  identity = {
    name                = var.name
    environment         = var.environment
    trust_domain        = var.trust_domain
    account_id          = data.aws_caller_identity.current.account_id
    region              = var.region
    vpc_id              = var.vpc_id
    subnet_ids          = sort(var.subnet_ids)
    kms_key_arn         = var.root_volume.kms_key_arn
    home_kms_key_arn    = var.home_volume == null ? null : var.home_volume.kms_key_arn
    tailscale_tags      = sort(var.tailscale.tags)
    routekit_principal  = var.routekit.principal
    routekit_policy     = var.routekit.routing_policy_version
    ami_id              = var.ami.id
    ami_manifest_sha256 = var.ami.manifest_sha256
    ami_kms_key_arn     = var.ami.image_kms_key_arn
  }
  release_fingerprint = sha256(jsonencode(local.identity))
  common_tags = merge(var.tags, {
    Name                    = var.name
    "routekit:trust-domain" = var.trust_domain
    "routekit:fingerprint"  = local.release_fingerprint
  })
  bootstrap = {
    schema_version = 1
    mode           = var.mode
    name           = var.name
    environment    = var.environment
    trust_domain   = var.trust_domain
    account_id     = data.aws_caller_identity.current.account_id
    region         = var.region
    ami = {
      id                   = var.ami.id
      architecture         = var.ami.architecture
      manifest_sha256      = var.ami.manifest_sha256
      manifest_s3_arn      = var.ami.manifest_s3_arn
      manifest_version_id  = var.ami.manifest_version_id
      manifest_kms_key_arn = var.ami.manifest_kms_key_arn
      image_kms_key_arn    = var.ami.image_kms_key_arn
    }
    routekit            = var.routekit
    tailscale           = var.tailscale
    service_user        = var.personal == null ? "routekit-runtime" : var.personal.service_user
    release_fingerprint = local.release_fingerprint
  }
  bootstrap_parameter_name = "/routekit/runtime/${var.trust_domain}/${local.release_fingerprint}"
  manifest_bucket          = split("/", trimprefix(var.ami.manifest_s3_arn, "arn:${data.aws_partition.current.partition}:s3:::"))[0]
  manifest_key             = join("/", slice(split("/", trimprefix(var.ami.manifest_s3_arn, "arn:${data.aws_partition.current.partition}:s3:::")), 1, length(split("/", trimprefix(var.ami.manifest_s3_arn, "arn:${data.aws_partition.current.partition}:s3:::")))))
  security_group_ids       = concat([aws_security_group.runtime.id], var.additional_security_group_ids)
}

resource "terraform_data" "contract" {
  input = local.release_fingerprint

  lifecycle {
    precondition {
      condition     = data.aws_region.current.region == var.region
      error_message = "region must match the supplied AWS provider region."
    }
    precondition {
      condition     = alltrue([for subnet in data.aws_subnet.runtime : subnet.vpc_id == var.vpc_id])
      error_message = "every subnet must belong to vpc_id."
    }
    precondition {
      condition     = var.development_single_az || (var.environment != "production" && local.is_personal) || length(local.subnet_azs) >= 2
      error_message = "production and pool calls require subnets in at least two AZs unless development_single_az is explicit."
    }
    precondition {
      condition     = (local.is_pool && var.capacity != null && var.personal == null && var.home_volume == null && var.runtime_lifecycle != null) || (local.is_personal && var.capacity == null && var.personal != null && var.home_volume != null && var.runtime_lifecycle == null)
      error_message = "pool mode requires capacity+runtime_lifecycle only; personal mode requires personal+home_volume only."
    }
    precondition {
      condition     = !local.is_personal || contains(var.subnet_ids, local.personal_subnet_id)
      error_message = "personal.subnet_id must be included in subnet_ids."
    }
    precondition {
      condition     = !local.personal_enabled || local.personal_home_enabled
      error_message = "a personal instance cannot be enabled until its durable home volume is provisioned."
    }
    precondition {
      condition     = data.aws_kms_key.root.arn == var.root_volume.kms_key_arn && split(":", var.root_volume.kms_key_arn)[3] == var.region && split(":", var.root_volume.kms_key_arn)[4] == data.aws_caller_identity.current.account_id
      error_message = "root KMS key must be in the module provider account and region."
    }
    precondition {
      condition     = data.aws_kms_key.manifest.arn == var.ami.manifest_kms_key_arn && split(":", var.ami.manifest_kms_key_arn)[3] == var.region && split(":", var.ami.manifest_kms_key_arn)[4] == data.aws_caller_identity.current.account_id
      error_message = "artifact KMS key must be in the module provider account and region."
    }
    precondition {
      condition     = data.aws_kms_key.image.arn == var.ami.image_kms_key_arn && split(":", var.ami.image_kms_key_arn)[3] == var.region && split(":", var.ami.image_kms_key_arn)[4] == data.aws_caller_identity.current.account_id
      error_message = "AMI KMS key must be in the module provider account and region."
    }
    precondition {
      condition     = var.home_volume == null || (data.aws_kms_key.home[0].arn == var.home_volume.kms_key_arn && split(":", var.home_volume.kms_key_arn)[3] == var.region && split(":", var.home_volume.kms_key_arn)[4] == data.aws_caller_identity.current.account_id)
      error_message = "home KMS key must be in the module provider account and region."
    }
    precondition {
      condition     = var.tags["environment"] == var.environment && var.tags["trust-domain"] == var.trust_domain
      error_message = "environment and trust-domain tag values must match their immutable inputs."
    }
  }
}
