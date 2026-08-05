variable "aws_profile" { type = string }
variable "region" {
  type    = string
  default = "us-west-2"
}
variable "name" {
  type    = string
  default = "routekit-runtime"
}
variable "base_ami_id" {
  description = "Pinned Ubuntu base AMI. Never resolved through a latest query."
  type        = string
}
variable "subnet_id" { type = string }
variable "security_group_ids" { type = list(string) }
variable "kms_key_arn" { type = string }
variable "artifact_bucket_name" { type = string }
variable "runtime_bundle" {
  type = object({ key = string, sha256 = string })
}
variable "node_bundle" {
  type = object({ key = string, sha256 = string, version = string })
}
variable "tailscale_bundle" {
  type = object({ key = string, sha256 = string, version = string })
}
variable "npm_lock_bundle" {
  type = object({ key = string, sha256 = string })
}
variable "runtime_manifest" {
  type = object({ key = string, sha256 = string, version_id = string })
}
variable "release" { type = string }
variable "tags" { type = map(string) }
