output "artifact_bucket" { value = aws_s3_bucket.artifacts.id }
output "manifest_signing_key_arn" { value = aws_kms_key.manifest_signing.arn }
output "image_arn" { value = aws_imagebuilder_image.runtime.arn }
output "ami_id" { value = one([for ami in aws_imagebuilder_image.runtime.output_resources[0].amis : ami.image]) }
output "runtime_manifest" {
  value = {
    s3_arn     = "${aws_s3_bucket.artifacts.arn}/${var.runtime_manifest.key}"
    sha256     = var.runtime_manifest.sha256
    version_id = var.runtime_manifest.version_id
  }
}
