terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    # Supply deploy/aws/backend.hcl. The bootstrap root prints the values.
    # Native S3 lockfiles are enabled with use_lockfile = true in that file.
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  default_tags {
    tags = merge(var.tags, {
      ManagedBy = "terraform"
      Project   = var.name_prefix
    })
  }
}
