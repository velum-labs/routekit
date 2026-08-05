variable "aws_profile" { type = string }
variable "region" {
  type    = string
  default = "us-west-2"
}
variable "name" { type = string }
variable "environment" { type = string }
variable "trust_domain" { type = string }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "subnet_ids" { type = list(string) }
variable "ami" {
  type = object({ id = string, architecture = string, manifest_sha256 = string, manifest_s3_arn = string, manifest_version_id = string, manifest_kms_key_arn = string, image_kms_key_arn = string })
}
variable "instance_types" {
  type    = list(string)
  default = ["m7i.xlarge"]
}
variable "capacity" {
  type    = object({ min = number, desired = number, max = number, purchase_model = string })
  default = { min = 0, desired = 0, max = 2, purchase_model = "on_demand" }
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
