variable "region" {
  type    = string
  default = "us-west-2"
}
variable "aws_profile" { type = string }
variable "name" {
  type    = string
  default = "routekit-runtime"
}
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "public_subnet_ids" {
  description = "One existing public subnet per AZ, used only to host that AZ's NAT gateway."
  type        = map(string)
}
variable "private_subnet_cidrs" {
  description = "One non-overlapping private subnet CIDR per AZ."
  type        = map(string)
  validation {
    condition     = length(var.private_subnet_cidrs) >= 2 && toset(keys(var.private_subnet_cidrs)) == toset(keys(var.public_subnet_ids))
    error_message = "private and public subnet maps must have identical keys and span at least two AZs."
  }
}
variable "tags" { type = map(string) }
