data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

resource "aws_s3_bucket" "artifacts" {
  bucket = var.artifact_bucket_name
  tags   = merge(var.tags, { Name = var.artifact_bucket_name })
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_kms_key" "manifest_signing" {
  description              = "RouteKit runtime manifest signing"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_NIST_P256"
  deletion_window_in_days  = 30
  tags                     = merge(var.tags, { Name = "${var.name}-manifest-signing" })
  lifecycle { prevent_destroy = true }
}

resource "aws_kms_alias" "manifest_signing" {
  name          = "alias/${var.name}-manifest-signing"
  target_key_id = aws_kms_key.manifest_signing.key_id
}

resource "aws_iam_role" "builder" {
  name_prefix = "${var.name}-image-builder-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = var.tags
}

resource "aws_iam_instance_profile" "builder" {
  name_prefix = "${var.name}-image-builder-"
  role        = aws_iam_role.builder.name
  tags        = var.tags
}

resource "aws_iam_role_policy_attachment" "builder_ssm" {
  role       = aws_iam_role.builder.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "builder_imagebuilder" {
  role       = aws_iam_role.builder.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/EC2InstanceProfileForImageBuilder"
}

resource "aws_iam_role_policy" "builder" {
  name_prefix = "artifacts-"
  role        = aws_iam_role.builder.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "${aws_s3_bucket.artifacts.arn}/*"
      },
      {
        Effect   = "Allow", Action = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.artifacts.arn}/imagebuilder-logs/*"
      },
      {
        Effect = "Allow", Action = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"], Resource = var.kms_key_arn
        Condition = {
          StringEquals = { "kms:ViaService" = "s3.${var.region}.${data.aws_partition.current.dns_suffix}" }
        }
      }
    ]
  })
}

locals {
  component_document = yamlencode({
    name          = "RouteKitRuntime"
    description   = "Install content-addressed RouteKit runtime artifacts"
    schemaVersion = 1.0
    phases = [{
      name = "build"
      steps = [
        {
          name = "DownloadArtifacts", action = "S3Download"
          inputs = [
            { source = "s3://${aws_s3_bucket.artifacts.id}/${var.runtime_bundle.key}", destination = "/tmp/runtime.tar.gz" },
            { source = "s3://${aws_s3_bucket.artifacts.id}/${var.node_bundle.key}", destination = "/tmp/node.tar.xz" },
            { source = "s3://${aws_s3_bucket.artifacts.id}/${var.tailscale_bundle.key}", destination = "/tmp/tailscale.tgz" },
            { source = "s3://${aws_s3_bucket.artifacts.id}/${var.npm_lock_bundle.key}", destination = "/tmp/native-clients.tgz" }
          ]
        },
        {
          name = "VerifyArtifacts", action = "ExecuteBash"
          inputs = { commands = [
            "echo '${var.runtime_bundle.sha256}  /tmp/runtime.tar.gz' | sha256sum -c -",
            "echo '${var.node_bundle.sha256}  /tmp/node.tar.xz' | sha256sum -c -",
            "echo '${var.tailscale_bundle.sha256}  /tmp/tailscale.tgz' | sha256sum -c -",
            "echo '${var.npm_lock_bundle.sha256}  /tmp/native-clients.tgz' | sha256sum -c -"
          ] }
        },
        {
          name = "InstallRuntime", action = "ExecuteBash"
          inputs = { commands = [
            "set -euo pipefail",
            "apt-get update",
            "DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential ca-certificates curl jq python3 xz-utils",
            "mkdir -p /opt /opt/routekit-runtime /var/lib/routekit-runtime /etc/routekit-runtime",
            "tar -xJf /tmp/node.tar.xz -C /opt",
            "ln -sfn /opt/node-v${var.node_bundle.version}-linux-x64 /opt/node",
            "ln -sfn /opt/node/bin/node /usr/local/bin/node",
            "ln -sfn /opt/node/bin/npm /usr/local/bin/npm",
            "ln -sfn /opt/node/bin/npx /usr/local/bin/npx",
            "tar --warning=no-unknown-keyword -xzf /tmp/runtime.tar.gz -C /",
            "tar --warning=no-unknown-keyword -xzf /tmp/tailscale.tgz -C /tmp",
            "install -m 0755 /tmp/tailscale_${var.tailscale_bundle.version}_amd64/tailscale /usr/local/bin/tailscale",
            "install -m 0755 /tmp/tailscale_${var.tailscale_bundle.version}_amd64/tailscaled /usr/local/sbin/tailscaled",
            "tar --warning=no-unknown-keyword -xzf /tmp/native-clients.tgz -C /tmp",
            "cd /tmp/native-clients && /opt/node/bin/npm ci --omit=dev --ignore-scripts=false",
            "mkdir -p /opt/native-clients && cp -a /tmp/native-clients/node_modules /opt/native-clients/",
            "for b in t3 codex claude; do target=/opt/native-clients/node_modules/.bin/$b; test -x \"$target\"; ln -sfn \"$target\" /usr/local/bin/\"$b\"; done",
            "ln -sfn /opt/routekit/dist/index.js /usr/local/bin/routekit",
            "install -m 0644 /opt/routekit-runtime/systemd/tailscaled.service /etc/systemd/system/tailscaled.service",
            "install -m 0644 /opt/routekit-runtime/systemd/routekit-workload-connector.service /etc/systemd/system/routekit-workload-connector.service",
            "install -m 0644 /opt/routekit-runtime/systemd/routekit-runtime-log-forwarder.service /etc/systemd/system/routekit-runtime-log-forwarder.service",
            "install -m 0644 /opt/routekit-runtime/systemd/routekit-runtime-supervisor.service /etc/systemd/system/routekit-runtime-supervisor.service",
            "mkdir -p /var/log/journal",
            "systemctl disable --now ssh.service ssh.socket 2>/dev/null || true",
            "systemctl daemon-reload",
            "systemctl enable routekit-runtime-log-forwarder.service",
            "systemctl enable routekit-runtime-supervisor.service"
          ] }
        }
      ]
      }, {
      name = "validate"
      steps = [{
        name = "VerifyVersions", action = "ExecuteBash"
        inputs = { commands = [
          "test \"$(/opt/node/bin/node --version)\" = 'v${var.node_bundle.version}'",
          "/usr/local/bin/routekit --version",
          "/usr/local/bin/t3 --version",
          "/usr/local/bin/codex --version",
          "/usr/local/bin/claude --version",
          "/opt/node/bin/node --check /opt/routekit-runtime/workload/dist/supervisor-main.js"
        ] }
      }]
    }]
  })
}

resource "aws_imagebuilder_component" "runtime" {
  name        = "${var.name}-${replace(var.release, ".", "-")}"
  platform    = "Linux"
  version     = var.release
  description = "Content-addressed T3 and RouteKit runtime"
  data        = local.component_document
  tags        = var.tags
}

resource "aws_imagebuilder_image_recipe" "runtime" {
  name         = "${var.name}-${replace(var.release, ".", "-")}"
  parent_image = var.base_ami_id
  version      = var.release

  block_device_mapping {
    device_name = "/dev/sda1"
    ebs {
      encrypted             = true
      kms_key_id            = var.kms_key_arn
      volume_size           = 40
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }
  component { component_arn = aws_imagebuilder_component.runtime.arn }
  tags = var.tags
}

resource "aws_imagebuilder_infrastructure_configuration" "runtime" {
  name                          = var.name
  instance_profile_name         = aws_iam_instance_profile.builder.name
  instance_types                = ["m7i.large"]
  subnet_id                     = var.subnet_id
  security_group_ids            = var.security_group_ids
  terminate_instance_on_failure = true
  logging {
    s3_logs {
      s3_bucket_name = aws_s3_bucket.artifacts.id
      s3_key_prefix  = "imagebuilder-logs"
    }
  }
  tags = var.tags
}

resource "aws_imagebuilder_distribution_configuration" "runtime" {
  name = var.name
  distribution {
    region = var.region
    ami_distribution_configuration {
      name               = "${var.name}-${var.release}-{{ imagebuilder:buildDate }}"
      kms_key_id         = var.kms_key_arn
      target_account_ids = [data.aws_caller_identity.current.account_id]
      ami_tags           = merge(var.tags, { RuntimeRelease = var.release })
    }
  }
  tags = var.tags
}

resource "aws_imagebuilder_image" "runtime" {
  image_recipe_arn                 = aws_imagebuilder_image_recipe.runtime.arn
  infrastructure_configuration_arn = aws_imagebuilder_infrastructure_configuration.runtime.arn
  distribution_configuration_arn   = aws_imagebuilder_distribution_configuration.runtime.arn
  enhanced_image_metadata_enabled  = true
  tags                             = var.tags
  lifecycle { create_before_destroy = true }
}
