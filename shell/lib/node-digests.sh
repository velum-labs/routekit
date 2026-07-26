# Pinned Node.js runtime digests for the private-runtime fallback.
# Regenerate with: node scripts/generate-node-digests.mjs
# Source: https://nodejs.org/dist/v${ROUTEKIT_NODE_VERSION}/SHASUMS256.txt
# shellcheck disable=SC2034
ROUTEKIT_NODE_VERSION=22.22.2
ROUTEKIT_NODE_MINIMUM_MAJOR=22

# sha256 of the .tar.gz for each supported platform (os/arch).
routekit_node_digest() {
  # $1 = os (linux|darwin), $2 = arch (x64|arm64)
  case "$1/$2" in
    linux/x64)   printf '%s\n' '978978a635eef872fa68beae09f0aad0bbbae6757e444da80b570964a97e62a3' ;;
    linux/arm64) printf '%s\n' 'b2f3a96f31486bfc365192ad65ced14833ad2a3c2e1bcefec4846902f264fa28' ;;
    darwin/x64)  printf '%s\n' '12a6abb9c2902cf48a21120da13f87fde1ed1b71a13330712949e8db818708ba' ;;
    darwin/arm64) printf '%s\n' 'db4b275b83736df67533529a18cc55de2549a8329ace6c7bcc68f8d22d3c9000' ;;
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
  printf '%s %s\n' "$_os" "$_arch"
}
