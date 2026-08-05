terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers { aws = { source = "hashicorp/aws", version = ">= 6.0.0, < 7.0.0" } }
}

provider "aws" { region = "us-west-2" }

module "personal" {
  source = "../.."

  mode                  = "personal"
  name                  = "example-t3-user"
  environment           = "development"
  trust_domain          = "example-user"
  region                = "us-west-2"
  vpc_id                = "vpc-0123456789abcdef0"
  subnet_ids            = ["subnet-0123456789abcdef0"]
  development_single_az = true
  ami = {
    id                   = "ami-0123456789abcdef0", architecture = "x86_64"
    manifest_sha256      = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    manifest_s3_arn      = "arn:aws:s3:::example/manifests/runtime.json", manifest_version_id = "version-1"
    manifest_kms_key_arn = "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-000000000000"
    image_kms_key_arn    = "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-000000000000"
  }
  instance_types = ["m7i.xlarge"]
  personal       = { subnet_id = "subnet-0123456789abcdef0", service_user = "alice" }
  root_volume    = { size_gib = 40, type = "gp3", encrypted = true, kms_key_arn = "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-000000000000", delete_on_termination = true }
  home_volume    = { size_gib = 200, type = "gp3", kms_key_arn = "arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-000000000000" }
  routekit = {
    endpoint                   = "https://routekit-gateway.example.ts.net", principal = "t3-alice"
    auth_mode                  = "credential_broker", credential_broker_ref = "svc:routekit-credentials"
    credential_broker_url      = "https://routekit-credentials.example.ts.net"
    credential_broker_audience = "routekit-credentials", routing_policy_version = "v1"
  }
  tailscale     = { enabled = true, tags = ["tag:t3-alice"], workload_identity_client_id = "TSAILCLIENTIDEXAMPLE", workload_identity_audience = "api.tailscale.com/TSAILCLIENTIDEXAMPLE", manage_tailnet_policy = false }
  observability = { log_retention_days = 30, alarm_topic_arns = [], detailed_monitoring = true }
  tags          = { owner = "alice", environment = "development", service = "t3", trust-domain = "example-user", data-class = "internal", cost-center = "engineering", managed-by = "terraform" }
}
