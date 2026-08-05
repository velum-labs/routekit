resource "aws_ssm_document" "efs_utils" {
  name            = "${var.name_prefix}-install-efs-utils"
  document_type   = "Command"
  document_format = "JSON"
  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Wait for cloud-init apt work, then install pinned Amazon EFS utilities"
    parameters = {
      EfsUtilsVersion = {
        type        = "String"
        description = "Exact AmazonEFSUtils package version"
      }
    }
    mainSteps = [
      {
        action = "aws:runShellScript"
        name   = "waitForCloudInitApt"
        inputs = {
          timeoutSeconds = "900"
          runCommand = [
            "for attempt in $(seq 1 180); do",
            "  [ -f /var/lib/routekit-bootstrap/apt-ready ] && exit 0",
            "  sleep 5",
            "done",
            "echo 'cloud-init apt readiness marker did not appear' >&2",
            "exit 1",
          ]
        }
      },
      {
        action = "aws:configurePackage"
        name   = "installEfsUtils"
        inputs = {
          name             = "AmazonEFSUtils"
          action           = "Install"
          installationType = "Uninstall and reinstall"
          version          = "{{ EfsUtilsVersion }}"
        }
      },
    ]
  })

  tags = { Name = "${var.name_prefix}-install-efs-utils" }
}

resource "aws_ssm_association" "efs_utils" {
  name             = aws_ssm_document.efs_utils.name
  document_version = aws_ssm_document.efs_utils.latest_version
  association_name = "${var.name_prefix}-efs-utils"

  parameters = {
    EfsUtilsVersion = var.efs_utils_version
  }

  targets {
    key    = "InstanceIds"
    values = sort([for name, _ in local.gateway_nodes : aws_instance.node[name].id])
  }
}
