variable "aws_region" {
  type    = string
  default = "us-west-2"

  validation {
    condition     = var.aws_region == "us-west-2"
    error_message = "The backend must be created in us-west-2."
  }
}

variable "aws_profile" {
  type        = string
  description = "Credential-process profile backed by the temporary aws login session."
}

variable "bucket_prefix" {
  type        = string
  description = "Globally unique lowercase prefix; account ID is appended."
  default     = "routekit-terraform"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,40}$", var.bucket_prefix))
    error_message = "bucket_prefix must be a valid lowercase S3 bucket prefix."
  }
}
