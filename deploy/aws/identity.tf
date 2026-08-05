data "aws_caller_identity" "current" {}

resource "aws_iam_role" "workload" {
  for_each = local.workload_identities

  name = "${var.name_prefix}-${each.key}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  for_each = aws_iam_role.workload

  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "tailscale_identity" {
  for_each = local.workload_identities

  name = "tailscale-workload-identity"
  role = aws_iam_role.workload[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "AllowGetWebIdentityTokenForTailscale"
      Effect   = "Allow"
      Action   = "sts:GetWebIdentityToken"
      Resource = "*"
      Condition = {
        "ForAnyValue:StringEquals" = {
          "sts:IdentityTokenAudience" = each.value.audience
        }
        NumericLessThanEquals = {
          "sts:DurationSeconds" = "300"
        }
      }
    }]
  })
}

resource "aws_iam_instance_profile" "workload" {
  for_each = aws_iam_role.workload

  name = each.value.name
  role = each.value.name
}
