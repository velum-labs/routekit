import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("../..", import.meta.url).pathname);
const read = (path) => readFileSync(resolve(root, path), "utf8");

function terraformBlock(source, kind, name) {
  const marker = `resource "${kind}" "${name}"`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${marker}`);
  const opening = source.indexOf("{", start + marker.length);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${marker}`);
}

test("AWS EC2 node groups expose no security-group ingress and require IMDSv2", () => {
  const network = read("deploy/aws/network.tf");
  for (const name of ["gateway", "t3"]) {
    const group = terraformBlock(network, "aws_security_group", name);
    assert.doesNotMatch(group, /\bingress\s*\{/);
    assert.match(group, /\begress\s*\{/);
  }
  const efs = terraformBlock(network, "aws_security_group", "efs");
  assert.match(efs, /from_port\s*=\s*2049/);
  assert.match(efs, /security_groups\s*=\s*\[aws_security_group\.gateway\.id\]/);

  const compute = read("deploy/aws/compute.tf");
  assert.match(compute, /http_tokens\s*=\s*"required"/);
  assert.match(compute, /instance_metadata_tags\s*=\s*"enabled"/);
  assert.match(compute, /root_block_device\s*\{[\s\S]*encrypted\s*=\s*true/);

  const variables = read("deploy/aws/variables.tf");
  assert.match(variables, /variable "t3_nodes"/);
  assert.doesNotMatch(variables, /length\(var\.t3_nodes\) == 2/);
});

test("AWS storage, backup, recovery, and workload identities retain the production safety contract", () => {
  const storage = read("deploy/aws/storage.tf");
  assert.match(storage, /aws_efs_file_system" "routekit"[\s\S]*encrypted\s*=\s*true/);
  assert.match(storage, /aws_ebs_volume" "t3_home"[\s\S]*size\s*=\s*var\.t3_home_volume_size_gib/);
  assert.match(storage, /aws_ebs_volume" "t3_home"[\s\S]*prevent_destroy\s*=\s*true/);
  assert.match(storage, /path\s*=\s*"\/state"/);
  assert.match(storage, /path\s*=\s*"\/config"/);

  const backup = read("deploy/aws/backup.tf");
  assert.match(backup, /cron\(0 0\/4 \* \* \? \*\)/);
  assert.match(backup, /delete_after\s*=\s*14/);
  assert.match(backup, /delete_after\s*=\s*30/);
  assert.match(backup, /AWSBackupServiceRolePolicyForRestores/);
  const monitoring = read("deploy/aws/monitoring.tf");
  assert.match(monitoring, /StatusCheckFailed_System/);
  assert.match(monitoring, /StatusCheckFailed_Instance/);
  assert.match(monitoring, /ec2:recover/);

  const identity = read("deploy/aws/identity.tf");
  assert.match(identity, /sts:GetWebIdentityToken/);
  assert.match(identity, /sts:IdentityTokenAudience/);
  assert.match(identity, /NumericLessThanEquals/);
  assert.doesNotMatch(identity, /tailscale.*(?:secret|auth.?key|api.?key)/i);
});

test("runtime artifacts remain readable by unprivileged systemd services", () => {
  const builder = read("deploy/aws/image/bin/build-runtime-artifacts");
  assert.match(builder, /^umask 022$/m);
  assert.match(
    builder,
    /chmod -R a\+rX "\$stage\/opt\/routekit-runtime" "\$stage\/opt\/routekit"/
  );
  assert.match(builder, /chmod a\+rx "\$stage\/opt\/routekit\/dist\/index\.js"/);
});

test("the reusable runtime module supports an optional exact broker-authorized IAM role name", () => {
  const variables = read("deploy/aws/modules/t3-routekit-runtime/variables.tf");
  const identity = terraformBlock(
    read("deploy/aws/modules/t3-routekit-runtime/identity.tf"),
    "aws_iam_role",
    "runtime"
  );
  const locals = read("deploy/aws/modules/t3-routekit-runtime/locals.tf");
  const outputs = read("deploy/aws/modules/t3-routekit-runtime/outputs.tf");
  const guide = read("deploy/aws/modules/t3-routekit-runtime/README.md");

  assert.match(variables, /variable "runtime_role_name"/);
  assert.match(variables, /default\s*=\s*null/);
  assert.match(variables, /\^\[A-Za-z0-9\+=,.@_-\]\{1,64\}\$/);
  assert.match(identity, /name\s*=\s*var\.runtime_role_name/);
  assert.match(
    identity,
    /name_prefix\s*=\s*var\.runtime_role_name == null \? "\$\{var\.name\}-runtime-" : null/
  );
  assert.match(locals, /runtime_role_name\s*=\s*var\.runtime_role_name/);
  assert.match(outputs, /module_contract_version\s*=\s*"1\.1\.0"/);
  assert.match(guide, /runtime_role_name[\s\S]*predeclared exact role ARN/);
  assert.match(guide, /terraform-aws-t3-routekit-runtime-v1\.1\.0/);
});

test("the reusable runtime reads only the exact version-pinned manifest object", () => {
  const policy = terraformBlock(
    read("deploy/aws/modules/t3-routekit-runtime/identity.tf"),
    "aws_iam_role_policy",
    "runtime"
  );
  const statement = policy.slice(
    policy.indexOf('Sid      = "ReadImmutableManifest"'),
    policy.indexOf('Sid      = "DecryptImmutableManifest"')
  );

  assert.match(statement, /Action\s*=\s*\["s3:GetObjectVersion"\]/);
  assert.doesNotMatch(statement, /"s3:GetObject"/);
  assert.match(statement, /Resource\s*=\s*var\.ami\.manifest_s3_arn/);
  assert.match(
    statement,
    /StringEquals\s*=\s*\{\s*"s3:VersionId"\s*=\s*var\.ami\.manifest_version_id\s*\}/
  );
});

test("the backend bootstrap starts locally and exposes an explicit post-apply migration override", () => {
  const versions = read("deploy/aws/bootstrap/versions.tf");
  const backendExample = read("deploy/aws/bootstrap/backend.tf.example");
  const backendConfigExample = read("deploy/aws/backend.hcl.example");
  const stackVariablesExample = read("deploy/aws/terraform.tfvars.example");
  const bootstrapVariablesExample = read("deploy/aws/bootstrap/terraform.tfvars.example");
  const guide = read("deploy/aws/README.md");

  assert.doesNotMatch(versions, /backend\s+"s3"/);
  assert.match(backendExample, /backend\s+"s3"/);
  assert.match(backendConfigExample, /profile\s*=\s*"routekit-admin-terraform"/);
  assert.match(stackVariablesExample, /aws_profile\s*=\s*"routekit-admin-terraform"/);
  assert.match(bootstrapVariablesExample, /aws_profile\s*=\s*"routekit-admin-terraform"/);
  assert.match(guide, /credential_process[\s\S]*aws configure export-credentials/);
  assert.match(guide, /key=bootstrap\/terraform\.tfstate/);
  assert.match(guide, /bootstrap\/backend\.tf\.example deploy\/aws\/bootstrap\/backend\.tf/);
  assert.ok(
    guide.indexOf("terraform -chdir=deploy/aws/bootstrap apply") <
      guide.indexOf("bootstrap/backend.tf.example")
  );
});

test("the tailnet guide authorizes tags before Terraform creates tagged identities", () => {
  const policy = read("deploy/aws/tailnet-policy.hujson.example");
  const guide = read("deploy/aws/README.md");

  assert.match(policy, /"tag:routekit-gateway"/);
  assert.match(policy, /"tag:t3-a"/);
  assert.match(policy, /"tag:t3-b"/);
  assert.doesNotMatch(policy, /alen|benja/i);
  assert.match(policy, /"ip": \["tcp:443"\]/);
  assert.match(policy, /"ip": \["tcp:22"\]/);
  assert.match(guide, /Merge the tag owners before[\s\S]*applying Terraform/);
  assert.ok(
    guide.indexOf("Merge [tailnet-policy.hujson.example]") <
      guide.indexOf("terraform -chdir=deploy/aws/tailnet apply")
  );
});

test("the tailnet root binds each RouteKit and Factory role to its own exact AWS issuer", () => {
  const main = read("deploy/aws/tailnet/main.tf");
  const variables = read("deploy/aws/tailnet/variables.tf");
  const example = read("deploy/aws/tailnet/terraform.tfvars.example");
  const outputs = read("deploy/aws/tailnet/outputs.tf");
  const policy = read("deploy/aws/tailnet-policy.hujson.example");
  const guide = read("deploy/aws/README.md");

  assert.match(main, /issuer\s*=\s*each\.value\.aws_oidc_issuer/);
  assert.doesNotMatch(main, /issuer\s*=\s*var\.aws_oidc_issuer/);
  assert.doesNotMatch(variables, /variable "aws_account_id"/);
  assert.doesNotMatch(variables, /variable "aws_oidc_issuer"/);
  assert.match(variables, /aws_account_id\s*=\s*string/);
  assert.match(variables, /aws_oidc_issuer\s*=\s*string/);
  assert.match(variables, /\$\{identity\.aws_account_id\}:role/);
  assert.match(variables, /tokens.*sts.*global.*api.*aws/);
  assert.match(variables, /distinct\(\[for identity[\s\S]*identity\.aws_role_arn/);
  assert.match(variables, /variable "factory_services_enabled"/);
  assert.match(variables, /factory_services_enabled requires all four exact Factory/);
  assert.match(example, /factory_services_enabled\s*=\s*true/);
  assert.match(main, /count\s*=\s*var\.factory_services_enabled \? 1 : 0/);

  for (const [identity, role, tag] of [
    ["factory_control", "factory-production-control-node", "tag:factory-control"],
    [
      "factory_public_worker_api",
      "factory-production-public-worker-api-EXAMPLE",
      "tag:factory-worker-api"
    ],
    ["factory_private_runtime", "factory-t3-private", "tag:t3-factory-private"],
    ["factory_public_runtime", "factory-t3-public", "tag:t3-factory-public"]
  ]) {
    assert.match(example, new RegExp(`${identity} = \\{[\\s\\S]*?role/${role}`));
    assert.match(example, new RegExp(`${identity} = \\{[\\s\\S]*?${tag}`));
  }
  assert.match(
    example,
    /factory_public_runtime = \{[\s\S]*aws_account_id\s*=\s*"222222222222"/
  );
  assert.match(
    example,
    /factory_private_runtime = \{[\s\S]*aws_account_id\s*=\s*"111111111111"/
  );

  for (const service of [
    "svc:routekit-gateway",
    "svc:routekit-credentials-production",
    "svc:factory-control",
    "svc:factory-worker-public"
  ]) {
    assert.match(main, new RegExp(service));
    assert.match(policy, new RegExp(service));
  }
  assert.match(outputs, /factory_control_service/);
  assert.match(outputs, /factory_public_worker_service/);
  assert.match(policy, /velum\.sh\/cap\/factory/);
  assert.match(policy, /velum\.sh\/cap\/factory-worker/);
  assert.match(
    guide,
    /private and public Factory roles never share a\s+global issuer assumption/
  );
  assert.match(guide, /reject any unexpected[\s\S]*destroy\/recreate/);
});

test("AWS preflight rejects an exhausted regional VPC quota before apply", () => {
  const preflight = read("deploy/aws/bin/preflight");

  assert.match(preflight, /describe-vpcs/);
  assert.match(preflight, /L-F678F1CE/);
  assert.match(preflight, /\$usage >= \$quota/);
  assert.match(preflight, /VPC quota exhausted/);
});

test("Ubuntu gateways receive pinned EFS utilities through SSM rather than apt", () => {
  const bootstrap = read("deploy/aws/templates/node.sh.tftpl");
  const association = read("deploy/aws/ssm.tf");

  assert.doesNotMatch(bootstrap, /apt-get install[^\n]*amazon-efs-utils/);
  assert.match(bootstrap, /apt-get install -y build-essential/);
  assert.match(bootstrap, /npm install --global --prefix \/opt\/routekit[\s\S]*@openai\/codex/);
  assert.match(bootstrap, /npm install --global --prefix \/opt\/routekit[\s\S]*@anthropic-ai\/claude-code/);
  assert.match(bootstrap, /\(umask 022; \/opt\/node\/bin\/npm install/);
  assert.match(bootstrap, /\/etc\/sudoers\.d\/routekit-admin/);
  assert.match(bootstrap, /chmod 0711 \/var\/lib\/routekit/);
  assert.match(bootstrap, /\[ -x \/sbin\/mount\.efs \]/);
  assert.match(bootstrap, /dpkg-query -W amazon-efs-utils/);
  assert.match(bootstrap, /grep -q '\^\\\[mount\\\]\$'/);
  assert.match(association, /aws:configurePackage/);
  assert.match(association, /AmazonEFSUtils/);
  assert.match(association, /EfsUtilsVersion\s*=\s*var\.efs_utils_version/);
  assert.match(association, /key\s*=\s*"InstanceIds"/);
  assert.match(association, /aws_instance\.node\[name\]\.id/);
  assert.match(association, /\/var\/lib\/routekit-bootstrap\/apt-ready/);
  assert.ok(
    bootstrap.indexOf("https://tailscale.com/install.sh") <
      bootstrap.indexOf("touch /var/lib/routekit-bootstrap/apt-ready")
  );
});

test("fresh gateways fail closed until their exact workload JWT verifier is synchronized", () => {
  const bootstrap = read("deploy/aws/templates/node.sh.tftpl");
  const compute = read("deploy/aws/compute.tf");

  assert.match(compute, /aws_region\s*=\s*var\.aws_region/);
  assert.match(bootstrap, /routekit-workload-jwt-sync/);
  assert.match(bootstrap, /\/routekit\/gateway\/production\/workload-jwt-config/);
  assert.match(bootstrap, /boto3\.client\("ssm", region_name="\$\{aws_region\}"\)/);
  assert.match(bootstrap, /python3-boto3/);
  assert.match(bootstrap, /workload JWT config is missing/);
  assert.match(bootstrap, /chown root:routekit "\$tmp"/);
  assert.match(bootstrap, /mv -f "\$tmp" \/etc\/routekit\/workload-jwt\.json/);
  assert.match(
    bootstrap,
    /Requires=routekit-workload-jwt-sync\.service[\s\S]*After=routekit-workload-jwt-sync\.service/
  );
  assert.match(bootstrap, /Environment=ROUTEKIT_WORKLOAD_JWT_CONFIG=\/etc\/routekit\/workload-jwt\.json/);
  assert.match(bootstrap, /Restart=on-failure/);
});

test("failover is mutexed, fences the old writer, verifies inference, and updates the marker last", () => {
  const script = read("deploy/aws/bin/gateway-failover");
  assert.match(script, /put-parameter --name "\$lock_parameter" --type String --value/);
  assert.doesNotMatch(
    script.slice(script.indexOf("acquire_lock()"), script.indexOf("fence_old_writer()")),
    /--overwrite/
  );
  assert.match(script, /routekit-service mask/);
  assert.match(script, /\.HostName == \$node and \.Online == true/);
  assert.match(script, /ec2 stop-instances/);
  assert.match(script, /v1\/models/);
  assert.match(script, /v1\/responses/);
  assert.match(script, /response\.output_text\.delta/);
  assert.match(script, /ROUTEKIT_FAILOVER_OK/);
  assert.match(script, /serve drain svc:routekit-gateway/);
  assert.match(script, /--service=svc:routekit-gateway/);
  assert.ok(
    script.lastIndexOf('put-parameter --name "$active_parameter"') >
      script.lastIndexOf("routekit --json remote add")
  );
});

test("gateway runtime deployment reloads the workload verifier into active gateways", () => {
  const script = read("deploy/aws/bin/gateway-runtime-deploy");
  assert.match(script, /systemctl daemon-reload/);
  assert.match(script, /systemctl restart routekit-workload-broker\.service/);
  assert.doesNotMatch(script, /8082\/health && exit 0/);
  assert.match(
    script,
    /if systemctl is-active --quiet routekit-gateway\.service; then systemctl restart routekit-gateway\.service; fi/
  );
  assert.match(
    script,
    /systemctl show routekit-gateway\.service -p Environment --value[\s\S]*ROUTEKIT_WORKLOAD_JWT_CONFIG=\/etc\/routekit\/workload-jwt\.json/
  );
  assert.ok(
    script.indexOf('test "$broker_ready" -eq 1') <
      script.indexOf("systemctl restart routekit-gateway.service")
  );
});
