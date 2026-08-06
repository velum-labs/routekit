variable "mode" {
  description = "Runtime ownership model: personal creates one durable host; pool creates immutable ASG workers."
  type        = string

  validation {
    condition     = contains(["personal", "pool"], var.mode)
    error_message = "mode must be personal or pool."
  }
}

variable "name" {
  description = "Stable lowercase resource prefix."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,31}$", var.name))
    error_message = "name must be 3-32 lowercase letters, digits, or hyphens."
  }
}

variable "runtime_role_name" {
  description = "Optional exact IAM role name for runtimes whose external workload broker authorizes a predeclared role ARN. Null preserves generated name-prefix behavior."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.runtime_role_name == null ||
      can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", var.runtime_role_name))
    )
    error_message = "runtime_role_name must be null or a valid 1-64 character IAM role name without a path."
  }
}

variable "environment" {
  description = "Stable lowercase environment identifier."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,31}$", var.environment))
    error_message = "environment must be a stable lowercase identifier."
  }
}

variable "trust_domain" {
  description = "Immutable trust-domain identifier. Changing it replaces compute."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,63}$", var.trust_domain))
    error_message = "trust_domain must be 3-64 lowercase letters, digits, or hyphens."
  }
}

variable "region" {
  description = "Expected AWS provider region."
  type        = string
}

variable "vpc_id" {
  description = "Existing caller-owned VPC."
  type        = string
}

variable "subnet_ids" {
  description = "Existing private subnets. Production pools must span at least two AZs."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 1 && length(distinct(var.subnet_ids)) == length(var.subnet_ids)
    error_message = "subnet_ids must contain distinct existing subnet IDs."
  }
}

variable "development_single_az" {
  description = "Explicit exception allowing a single-AZ non-production module call."
  type        = bool
  default     = false
}

variable "ami" {
  description = "Immutable, pre-baked runtime AMI and signed manifest reference."
  type = object({
    id                   = string
    architecture         = string
    manifest_sha256      = string
    manifest_s3_arn      = string
    manifest_version_id  = string
    manifest_kms_key_arn = string
    image_kms_key_arn    = string
  })

  validation {
    condition = (
      can(regex("^ami-[0-9a-f]+$", var.ami.id)) &&
      contains(["x86_64", "arm64"], var.ami.architecture) &&
      can(regex("^[0-9a-f]{64}$", var.ami.manifest_sha256)) &&
      can(regex("^arn:[^:]+:s3:::[^/]+/.+$", var.ami.manifest_s3_arn)) &&
      can(regex("^arn:[^:]+:kms:[^:]+:[0-9]{12}:key/.+$", var.ami.manifest_kms_key_arn)) &&
      can(regex("^arn:[^:]+:kms:[^:]+:[0-9]{12}:key/.+$", var.ami.image_kms_key_arn)) &&
      length(var.ami.manifest_version_id) > 0
    )
    error_message = "ami requires an ID, supported architecture, SHA-256, exact S3 ARN/version, and artifact/image KMS key ARNs."
  }
}

variable "instance_types" {
  description = "Pinned allowlist of EC2 instance types. Personal mode uses the first entry."
  type        = list(string)

  validation {
    condition = (
      length(var.instance_types) >= 1 &&
      length(distinct(var.instance_types)) == length(var.instance_types) &&
      alltrue([for value in var.instance_types : can(regex("^[a-z][a-z0-9.-]+$", value))])
    )
    error_message = "instance_types must be a non-empty distinct allowlist."
  }
}

variable "capacity" {
  description = "Pool capacity. Must be null in personal mode."
  type = object({
    min            = number
    desired        = number
    max            = number
    purchase_model = string
  })
  default  = null
  nullable = true

  validation {
    condition = var.capacity == null || (
      var.capacity.min >= 0 &&
      var.capacity.min <= var.capacity.desired &&
      var.capacity.desired <= var.capacity.max &&
      floor(var.capacity.min) == var.capacity.min &&
      floor(var.capacity.desired) == var.capacity.desired &&
      floor(var.capacity.max) == var.capacity.max &&
      contains(["on_demand", "spot"], var.capacity.purchase_model)
    )
    error_message = "capacity must satisfy 0 <= min <= desired <= max and use on_demand or spot."
  }
}

variable "personal" {
  description = "Durable single-user settings. Required only in personal mode."
  type = object({
    subnet_id                   = string
    service_user                = string
    enabled                     = optional(bool, true)
    provision_home              = optional(bool, true)
    home_device_name            = optional(string, "/dev/sdf")
    disable_api_termination     = optional(bool, true)
    stop_instance_before_detach = optional(bool, true)
  })
  default  = null
  nullable = true
}

variable "root_volume" {
  description = "Encrypted root volume. A caller-supplied KMS key is mandatory."
  type = object({
    size_gib              = number
    type                  = string
    encrypted             = bool
    kms_key_arn           = string
    delete_on_termination = bool
    iops                  = optional(number)
    throughput            = optional(number)
  })

  validation {
    condition = (
      var.root_volume.size_gib >= 20 &&
      contains(["gp3", "io2"], var.root_volume.type) &&
      var.root_volume.encrypted &&
      can(regex("^arn:[^:]+:kms:[^:]+:[0-9]{12}:key/.+$", var.root_volume.kms_key_arn))
    )
    error_message = "root_volume must use gp3/io2, encryption, and a caller KMS key."
  }
}

variable "home_volume" {
  description = "Retained personal home volume. Required only in personal mode."
  type = object({
    size_gib    = number
    type        = string
    kms_key_arn = string
    iops        = optional(number)
    throughput  = optional(number)
    snapshot_id = optional(string)
  })
  default  = null
  nullable = true
}

variable "routekit" {
  description = "Nonsecret gateway and credential-broker contract."
  type = object({
    endpoint                   = string
    principal                  = string
    auth_mode                  = string
    credential_broker_ref      = optional(string)
    credential_broker_url      = optional(string)
    credential_broker_audience = optional(string)
    secret_arn                 = optional(string)
    allow_secrets_manager      = optional(bool, false)
    routing_policy_version     = string
  })

  validation {
    condition = (
      can(regex("^https://", var.routekit.endpoint)) &&
      can(regex("^[a-z][a-z0-9-]{2,127}$", var.routekit.principal)) &&
      contains(["credential_broker", "secrets_manager"], var.routekit.auth_mode) &&
      length(var.routekit.routing_policy_version) > 0 &&
      (
        (var.routekit.auth_mode == "credential_broker" && try(can(regex("^svc:[a-z][a-z0-9-]+$", var.routekit.credential_broker_ref)), false) && try(can(regex("^https://", var.routekit.credential_broker_url)), false) && try(length(var.routekit.credential_broker_audience) > 0, false) && try(var.routekit.secret_arn, null) == null) ||
        (var.routekit.auth_mode == "secrets_manager" && var.routekit.allow_secrets_manager && try(can(regex("^arn:[^:]+:secretsmanager:", var.routekit.secret_arn)), false))
      )
    )
    error_message = "routekit must select one nonsecret broker reference or an explicitly enabled Secrets Manager fallback."
  }
}

variable "tailscale" {
  description = "Tailscale workload identity bootstrap. Tailnet policy remains caller-owned."
  type = object({
    enabled                     = bool
    tags                        = list(string)
    workload_identity_client_id = optional(string)
    workload_identity_audience  = optional(string)
    manage_tailnet_policy       = bool
  })

  validation {
    condition = (
      !var.tailscale.manage_tailnet_policy &&
      (
        !var.tailscale.enabled ||
        (
          length(var.tailscale.tags) >= 1 &&
          alltrue([for tag in var.tailscale.tags : can(regex("^tag:[a-z][a-z0-9-]{1,62}$", tag))]) &&
          try(length(var.tailscale.workload_identity_client_id) >= 16, false) &&
          try(length(var.tailscale.workload_identity_audience) > 0, false)
        )
      )
    )
    error_message = "Tailscale policy is never module-managed; enabled mode requires immutable tags, client ID, and audience."
  }
}

variable "runtime_lifecycle" {
  description = "Pool refresh and external lossless-drain contract."
  type = object({
    launch_before_terminate           = bool
    instance_warmup_seconds           = number
    launch_timeout_seconds            = number
    drain_timeout_seconds             = number
    event_bus_arn                     = string
    auto_rollback                     = bool
    maximum_instance_lifetime_seconds = optional(number)
    capacity_rebalance                = optional(bool, false)
  })
  default  = null
  nullable = true
}

variable "observability" {
  description = "Module-local logs, metrics, alarms, and session logging."
  type = object({
    log_retention_days          = number
    alarm_topic_arns            = list(string)
    detailed_monitoring         = bool
    central_log_destination_arn = optional(string)
    ssm_session_log_bucket_name = optional(string)
    ssm_session_log_kms_key_arn = optional(string)
  })

  validation {
    condition     = var.observability.log_retention_days >= 30 && var.observability.detailed_monitoring
    error_message = "production observability requires at least 30 days retention and detailed monitoring."
  }
}

variable "egress_rules" {
  description = "Explicit egress grants. No implicit internet-wide rule is created."
  type = list(object({
    description       = string
    protocol          = string
    from_port         = number
    to_port           = number
    cidr_blocks       = optional(list(string), [])
    ipv6_cidr_blocks  = optional(list(string), [])
    prefix_list_ids   = optional(list(string), [])
    security_group_id = optional(string)
  }))
  default = []
}

variable "additional_security_group_ids" {
  description = "Caller-owned sidecar security groups composed with the module no-ingress group."
  type        = list(string)
  default     = []
}

variable "workload_policy_arns" {
  description = "Caller-owned workload-specific managed policy attachments."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Required organizational tags. Values must contain no credentials or source content."
  type        = map(string)

  validation {
    condition = alltrue([
      for key in ["owner", "environment", "service", "trust-domain", "data-class", "cost-center", "managed-by"] :
      contains(keys(var.tags), key) && length(var.tags[key]) > 0
    ])
    error_message = "tags must include owner, environment, service, trust-domain, data-class, cost-center, and managed-by."
  }
}
