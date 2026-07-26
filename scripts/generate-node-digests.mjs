/**
 * Regenerate shell/lib/node-digests.sh from nodejs.org SHASUMS256.txt.
 *
 * Usage:
 *   node scripts/generate-node-digests.mjs [version]
 *   node scripts/generate-node-digests.mjs --check [version]
 *
 * Defaults to the version currently pinned in shell/lib/node-digests.sh.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const digestsPath = join(root, "shell/lib/node-digests.sh");
const checkMode = process.argv.includes("--check");
const versionArg = process.argv.find(
  (arg, index) => index > 1 && !arg.startsWith("--") && /^\d+\.\d+\.\d+/.test(arg)
);

function pinnedVersion() {
  if (!existsSync(digestsPath)) return "22.22.2";
  const match = /ROUTEKIT_NODE_VERSION=(\d+\.\d+\.\d+)/.exec(
    readFileSync(digestsPath, "utf8")
  );
  return match?.[1] ?? "22.22.2";
}

const version = versionArg ?? pinnedVersion();
const platforms = [
  ["linux", "x64"],
  ["linux", "arm64"],
  ["darwin", "x64"],
  ["darwin", "arm64"]
];

const response = await fetch(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`);
if (!response.ok) {
  console.error(`failed to fetch SHASUMS256.txt for v${version}: ${response.status}`);
  process.exit(1);
}
const body = await response.text();
const digests = new Map();
for (const line of body.split("\n")) {
  const match = /^([0-9a-f]{64})\s+(node-v[\d.]+-([a-z0-9]+)-([a-z0-9]+)\.tar\.gz)$/.exec(
    line.trim()
  );
  if (match === null) continue;
  digests.set(`${match[3]}/${match[4]}`, match[1]);
}

for (const [os, arch] of platforms) {
  if (!digests.has(`${os}/${arch}`)) {
    console.error(`missing digest for ${os}/${arch} in Node v${version}`);
    process.exit(1);
  }
}

const rendered = `# Pinned Node.js runtime digests for the private-runtime fallback.
# Regenerate with: node scripts/generate-node-digests.mjs
# Source: https://nodejs.org/dist/v\${ROUTEKIT_NODE_VERSION}/SHASUMS256.txt
# shellcheck disable=SC2034
ROUTEKIT_NODE_VERSION=${version}
ROUTEKIT_NODE_MINIMUM_MAJOR=22

# sha256 of the .tar.gz for each supported platform (os/arch).
routekit_node_digest() {
  # $1 = os (linux|darwin), $2 = arch (x64|arm64)
  case "$1/$2" in
    linux/x64)   printf '%s\\n' '${digests.get("linux/x64")}' ;;
    linux/arm64) printf '%s\\n' '${digests.get("linux/arm64")}' ;;
    darwin/x64)  printf '%s\\n' '${digests.get("darwin/x64")}' ;;
    darwin/arm64) printf '%s\\n' '${digests.get("darwin/arm64")}' ;;
    *) return 1 ;;
  esac
}

routekit_node_platform() {
  # Prints "os arch" (nodejs.org naming) or fails.
  _os=$(uname -s 2>/dev/null || echo unknown)
  _arch=$(uname -m 2>/dev/null || echo unknown)
  case "$_os" in
    Linux) _os=linux ;;
    Darwin) _os=darwin ;;
    *) return 1 ;;
  esac
  case "$_arch" in
    x86_64|amd64) _arch=x64 ;;
    aarch64|arm64) _arch=arm64 ;;
    *) return 1 ;;
  esac
  printf '%s %s\\n' "$_os" "$_arch"
}
`;

if (checkMode) {
  if (!existsSync(digestsPath)) {
    console.error("node digests check failed: missing shell/lib/node-digests.sh");
    process.exit(1);
  }
  if (readFileSync(digestsPath, "utf8") !== rendered) {
    console.error(
      "node digests check failed: shell/lib/node-digests.sh is stale; " +
        "run `node scripts/generate-node-digests.mjs`"
    );
    process.exit(1);
  }
  console.log("node digests check passed");
  process.exit(0);
}

writeFileSync(digestsPath, rendered);
console.log(`wrote shell/lib/node-digests.sh (Node v${version})`);
