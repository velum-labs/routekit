resource "aws_security_group" "runtime" {
  name_prefix = "${var.name}-runtime-"
  description = "No-ingress RouteKit runtime ${var.trust_domain}"
  vpc_id      = var.vpc_id

  tags = merge(local.common_tags, { Name = "${var.name}-runtime" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "cidr" {
  for_each = {
    for item in flatten([
      for rule_index, rule in var.egress_rules : [
        for cidr_index, cidr in rule.cidr_blocks : {
          key = "${rule_index}-ipv4-${cidr_index}", rule = rule, cidr = cidr
        }
      ]
    ]) : item.key => item
  }
  security_group_id = aws_security_group.runtime.id
  description       = each.value.rule.description
  ip_protocol       = each.value.rule.protocol
  from_port         = each.value.rule.from_port
  to_port           = each.value.rule.to_port
  cidr_ipv4         = each.value.cidr
}

resource "aws_vpc_security_group_egress_rule" "ipv6" {
  for_each = {
    for item in flatten([
      for rule_index, rule in var.egress_rules : [
        for cidr_index, cidr in rule.ipv6_cidr_blocks : {
          key = "${rule_index}-ipv6-${cidr_index}", rule = rule, cidr = cidr
        }
      ]
    ]) : item.key => item
  }
  security_group_id = aws_security_group.runtime.id
  description       = each.value.rule.description
  ip_protocol       = each.value.rule.protocol
  from_port         = each.value.rule.from_port
  to_port           = each.value.rule.to_port
  cidr_ipv6         = each.value.cidr
}

resource "aws_vpc_security_group_egress_rule" "prefix" {
  for_each = {
    for item in flatten([
      for rule_index, rule in var.egress_rules : [
        for prefix_index, prefix in rule.prefix_list_ids : {
          key = "${rule_index}-prefix-${prefix_index}", rule = rule, prefix = prefix
        }
      ]
    ]) : item.key => item
  }
  security_group_id = aws_security_group.runtime.id
  description       = each.value.rule.description
  ip_protocol       = each.value.rule.protocol
  from_port         = each.value.rule.from_port
  to_port           = each.value.rule.to_port
  prefix_list_id    = each.value.prefix
}

resource "aws_vpc_security_group_egress_rule" "security_group" {
  for_each = {
    for index, rule in var.egress_rules : tostring(index) => rule
    if rule.security_group_id != null
  }
  security_group_id            = aws_security_group.runtime.id
  description                  = each.value.description
  ip_protocol                  = each.value.protocol
  from_port                    = each.value.from_port
  to_port                      = each.value.to_port
  referenced_security_group_id = each.value.security_group_id
}
