output "backend" {
  description = "Copy these nonsecret values into ../backend.hcl."
  value = {
    bucket       = aws_s3_bucket.terraform.bucket
    key          = "production/routekit.tfstate"
    region       = var.aws_region
    profile      = var.aws_profile
    encrypt      = true
    kms_key_id   = aws_kms_key.terraform.arn
    use_lockfile = true
  }
}
