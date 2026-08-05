variable "aws_profile" { type = string }
variable "region" {
  type    = string
  default = "us-west-2"
}
variable "name" { type = string }
variable "environment" {
  type    = string
  default = "production"
}
variable "trust_domain" { type = string }
variable "service_user" { type = string }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "subnet_ids" { type = list(string) }
variable "personal_subnet_id" { type = string }
variable "instance_enabled" {
  description = "Create the instance only after its exact IAM role subject is authorized in Tailscale."
  type        = bool
  default     = false
}
variable "home_provisioned" {
  description = "Create the retained home volume only after a final migration snapshot is supplied."
  type        = bool
  default     = false
}
variable "ami" {
  type = object({ id = string, architecture = string, manifest_sha256 = string, manifest_s3_arn = string, manifest_version_id = string, manifest_kms_key_arn = string, image_kms_key_arn = string })
}
variable "source_snapshot_id" {
  type     = string
  default  = null
  nullable = true
}
variable "source_snapshot_region" {
  type    = string
  default = "us-west-2"
}
variable "home_size_gib" {
  type    = number
  default = 200
}
variable "routekit_endpoint" { type = string }
variable "routekit_principal" { type = string }
variable "routekit_broker_ref" { type = string }
variable "routekit_broker_url" { type = string }
variable "routekit_broker_audience" { type = string }
variable "routekit_policy_version" { type = string }
variable "tailscale_client_id" { type = string }
variable "tailscale_audience" { type = string }
variable "tailscale_tag" { type = string }
variable "alarm_topic_arns" {
  type    = list(string)
  default = []
}
variable "tags" { type = map(string) }
