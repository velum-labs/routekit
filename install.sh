set -u
PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
nvm_dir=${NVM_DIR:-$HOME/.nvm}
nvm_bin=""
if [ -d "$nvm_dir/versions/node" ]; then
  if [ -f "$nvm_dir/alias/default" ]; then
    nvm_want=$(cat "$nvm_dir/alias/default" 2>/dev/null || echo "")
    for nvm_name in "$nvm_want" "v$nvm_want"; do
      if [ -n "$nvm_want" ] && [ -d "$nvm_dir/versions/node/$nvm_name/bin" ]; then
        nvm_bin="$nvm_dir/versions/node/$nvm_name/bin"
        break
      fi
    done
  fi
  if [ -z "$nvm_bin" ]; then
    # shellcheck disable=SC2012
    nvm_name=$(ls "$nvm_dir/versions/node" 2>/dev/null |
      sort -t. -k1.2,1n -k2,2n -k3,3n 2>/dev/null | tail -n 1)
    if [ -n "$nvm_name" ] && [ -d "$nvm_dir/versions/node/$nvm_name/bin" ]; then
      nvm_bin="$nvm_dir/versions/node/$nvm_name/bin"
    fi
  fi
fi
if [ -n "$nvm_bin" ]; then PATH="$nvm_bin:$PATH"; fi
export PATH
# Shared host detection helpers. Expanded via `# include` into the probe and
# the public installer so the two cannot drift on Node/npm/prefix writability.
# Does not mutate positional parameters.
have() { command -v "$1" >/dev/null 2>&1; }

# Variables set here are read by the including script after return.
# shellcheck disable=SC2034
routekit_detect() {
  os=$(uname -s 2>/dev/null || echo unknown)
  arch=$(uname -m 2>/dev/null || echo unknown)
  node_version=""
  npm_version=""
  npm_prefix=""
  npm_prefix_writable=no
  if have node; then node_version=$(node --version 2>/dev/null || echo unknown); fi
  if have npm; then
    npm_version=$(npm --version 2>/dev/null || echo unknown)
    npm_prefix=$(npm prefix -g 2>/dev/null || echo "")
    if [ -n "$npm_prefix" ]; then
      if [ -w "$npm_prefix/lib/node_modules" ]; then
        npm_prefix_writable=yes
      elif [ ! -e "$npm_prefix/lib/node_modules" ] && [ -w "$npm_prefix" ]; then
        npm_prefix_writable=yes
      fi
    fi
  fi
  routekit_version=""
  if have routekit; then
    # Take the second whitespace-separated field of `routekit version` without
    # clobbering the caller's positional parameters.
    routekit_version=$(
      routekit version 2>/dev/null | head -n 1 | awk '{ print $2 }'
    )
    if [ -z "$routekit_version" ]; then routekit_version=unknown; fi
  fi
  supervisor=none
  if [ "$os" = "Darwin" ]; then
    if have launchctl; then supervisor=launchd; fi
  elif have systemctl; then
    if systemctl --user show-environment >/dev/null 2>&1; then supervisor=systemd; fi
  fi
  config_exists=no
  if [ -f "$HOME/.config/routekit/router.yaml" ]; then config_exists=yes; fi
  state=${ROUTEKIT_HOME:-$HOME/.routekit}
  daemon_running=no
  if [ -f "$state/services/daemon.json" ]; then daemon_running=yes; fi
}
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
# Download, digest-verify, and extract a pinned Node.js runtime into
# $ROUTEKIT_NODE_ROOT (default: ~/.local/share/routekit/node).
# Requires: curl or wget, tar, and sha256sum or shasum.

routekit_sha256() {
  # Verify $1 against expected hex digest $2. Fail closed.
  if have sha256sum; then
    _got=$(sha256sum "$1" | awk '{ print $1 }')
  elif have shasum; then
    _got=$(shasum -a 256 "$1" | awk '{ print $1 }')
  else
    echo "RouteKit installer: need sha256sum or shasum to verify the Node.js download" >&2
    return 1
  fi
  if [ "$_got" != "$2" ]; then
    echo "RouteKit installer: Node.js digest mismatch (got $_got, want $2)" >&2
    return 1
  fi
}

routekit_download() {
  # $1 = url, $2 = dest
  if have curl; then
    curl -fsSL "$1" -o "$2"
  elif have wget; then
    wget -qO "$2" "$1"
  else
    echo "RouteKit installer: need curl or wget to download Node.js" >&2
    return 1
  fi
}

routekit_bootstrap_node() {
  # Sets PATH to include the private Node bin. Idempotent when already present.
  ROUTEKIT_NODE_ROOT=${ROUTEKIT_NODE_ROOT:-$HOME/.local/share/routekit/node}
  _platform=$(routekit_node_platform) || {
    echo "RouteKit installer: unsupported platform for private Node runtime" >&2
    return 1
  }
  _os=${_platform% *}
  _arch=${_platform#* }
  _digest=$(routekit_node_digest "$_os" "$_arch") || {
    echo "RouteKit installer: no pinned Node digest for $_os/$_arch" >&2
    return 1
  }
  _name="node-v${ROUTEKIT_NODE_VERSION}-${_os}-${_arch}"
  _bin="$ROUTEKIT_NODE_ROOT/${_name}/bin"
  if [ -x "$_bin/node" ] && [ -x "$_bin/npm" ]; then
    PATH="$_bin:$PATH"
    export PATH
    return 0
  fi
  _url="https://nodejs.org/dist/v${ROUTEKIT_NODE_VERSION}/${_name}.tar.gz"
  _tmp="${TMPDIR:-/tmp}/routekit-node.$$"
  if ! mkdir "$_tmp" 2>/dev/null; then
    echo "RouteKit installer: could not create temporary directory $_tmp" >&2
    return 1
  fi
  echo "RouteKit installer: downloading Node.js ${ROUTEKIT_NODE_VERSION} ($_os/$_arch)" >&2
  if ! routekit_download "$_url" "$_tmp/node.tar.gz"; then
    rm -rf "$_tmp"
    return 1
  fi
  if ! routekit_sha256 "$_tmp/node.tar.gz" "$_digest"; then
    rm -rf "$_tmp"
    return 1
  fi
  mkdir -p "$ROUTEKIT_NODE_ROOT"
  if ! tar -xzf "$_tmp/node.tar.gz" -C "$ROUTEKIT_NODE_ROOT"; then
    rm -rf "$_tmp"
    return 1
  fi
  rm -rf "$_tmp"
  if [ ! -x "$_bin/node" ]; then
    echo "RouteKit installer: Node.js extract did not produce $_bin/node" >&2
    return 1
  fi
  PATH="$_bin:$PATH"
  export PATH
}
# RouteKit public installer.
# shellcheck disable=SC2154,SC2034
# One-liner:
#   curl -fsSL https://github.com/velum-labs/routekit/releases/latest/download/install.sh | sh
# Prefer a system Node.js >= 22 with a writable npm prefix; otherwise download
# a pinned Node runtime into ~/.local/share/routekit/node and install into a
# private prefix with a ~/.local/bin/routekit shim. Never escalates with sudo.

ROUTEKIT_PACKAGE=${ROUTEKIT_PACKAGE:-@velum-labs/routekit}

routekit_usage() {
  cat <<'EOF' >&2
Usage: install.sh [--version <semver|latest>] [--prefix <dir>] [--dry-run]

Install or upgrade the RouteKit CLI. No sudo. Prefers a system Node.js 22+
with a writable npm prefix; otherwise bootstraps a private Node runtime.
EOF
}

routekit_node_major() {
  # $1 = vX.Y.Z or X.Y.Z
  _v=${1#v}
  _major=${_v%%.*}
  case "$_major" in
    ''|*[!0-9]*) return 1 ;;
    *) printf '%s\n' "$_major" ;;
  esac
}

routekit_validate_version() {
  case "$1" in
    latest) return 0 ;;
    [0-9]*.[0-9]*.[0-9]*) return 0 ;;
    [0-9]*.[0-9]*.[0-9]*-[A-Za-z0-9.-]*) return 0 ;;
    *)
      echo "RouteKit installer: invalid version: $1" >&2
      echo "pass an exact version such as 1.2.3, or latest" >&2
      return 1
      ;;
  esac
}

routekit_ensure_runtime() {
  # Decide between system Node/npm and the private runtime. Sets
  # ROUTEKIT_NPM_PREFIX when using a private prefix.
  _requested_prefix=$ROUTEKIT_NPM_PREFIX
  routekit_detect
  _major=""
  if [ -n "$node_version" ]; then
    _major=$(routekit_node_major "$node_version" || echo "")
  fi
  if [ -n "$_major" ] && [ "$_major" -ge "$ROUTEKIT_NODE_MINIMUM_MAJOR" ] &&
    [ "$npm_prefix_writable" = "yes" ] && have npm; then
    ROUTEKIT_INSTALL_MODE=system
    return 0
  fi
  echo "RouteKit installer: using private Node.js ${ROUTEKIT_NODE_VERSION} runtime" >&2
  routekit_bootstrap_node || return 1
  ROUTEKIT_NPM_EXECUTABLE=$(command -v npm 2>/dev/null || echo "")
  ROUTEKIT_NODE_EXECUTABLE=$(command -v node 2>/dev/null || echo "")
  ROUTEKIT_NPM_PREFIX=${_requested_prefix:-$HOME/.local}
  mkdir -p "$ROUTEKIT_NPM_PREFIX"
  npm config set prefix "$ROUTEKIT_NPM_PREFIX" >/dev/null 2>&1 || true
  PATH="$ROUTEKIT_NPM_PREFIX/bin:$PATH"
  export PATH
  ROUTEKIT_INSTALL_MODE=private
}

routekit_install_package() {
  # $1 = version (semver or latest)
  _spec="${ROUTEKIT_PACKAGE}@$1"
  if [ "$ROUTEKIT_INSTALL_MODE" = "private" ]; then
    npm install -g --prefix "$ROUTEKIT_NPM_PREFIX" "$_spec" >&2 || return 1
  else
    npm install -g "$_spec" >&2 || return 1
  fi
  # Ensure a user-local shim when the private prefix bin is not already on PATH
  # for non-interactive shells (covered by the preamble for SSH).
  if [ "$ROUTEKIT_INSTALL_MODE" = "private" ]; then
    mkdir -p "$HOME/.local/bin"
    _bin="$ROUTEKIT_NPM_PREFIX/bin/routekit"
    _shim="$HOME/.local/bin/routekit"
    if [ -x "$_bin" ]; then
      # When the private prefix is already ~/.local, npm wrote the real bin
      # link at $_shim. Recreating that link as a symlink-to-self breaks PATH.
      if [ "$_bin" != "$_shim" ]; then
        ln -sfn "$_bin" "$_shim"
      fi
    fi
    PATH="$HOME/.local/bin:$PATH"
    export PATH
  fi
  if ! have routekit; then
    echo "RouteKit installer: routekit is not on PATH after installation" >&2
    return 127
  fi
}

routekit_write_install_receipt() {
  if [ "$ROUTEKIT_INSTALL_MODE" = "private" ]; then
    _prefix=$ROUTEKIT_NPM_PREFIX
  else
    _prefix=$(npm prefix -g 2>/dev/null || echo "")
  fi
  _npm=${ROUTEKIT_NPM_EXECUTABLE:-$(command -v npm 2>/dev/null || echo "")}
  _node=${ROUTEKIT_NODE_EXECUTABLE:-$(command -v node 2>/dev/null || echo "")}
  if [ -z "$_prefix" ] || [ -z "$_npm" ] || [ -z "$_node" ]; then
    echo "RouteKit installer: could not resolve install receipt paths" >&2
    return 1
  fi
  "$_node" - "$_prefix" "$_npm" "$_node" "$ROUTEKIT_INSTALL_MODE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [, , rawPrefix, rawNpmExecutable, rawNodeExecutable, installMode] = process.argv;
const prefix = path.resolve(rawPrefix);
const npmExecutable = path.resolve(rawNpmExecutable);
const nodeExecutable = path.resolve(rawNodeExecutable);
const routekitExecutable = path.join(prefix, "bin", "routekit");
if (!fs.existsSync(routekitExecutable)) {
  throw new Error(`installed RouteKit executable is missing: ${routekitExecutable}`);
}
const directory = path.join(prefix, "lib", "routekit");
const target = path.join(directory, "install.json");
const temporary = `${target}.${process.pid}.tmp`;
const receipt = {
  schemaVersion: 1,
  provenance: "routekit-installer",
  manager: "npm",
  packageName: "@velum-labs/routekit",
  prefix,
  npmExecutable,
  nodeExecutable,
  routekitExecutable,
  installMode
};
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
try {
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
} finally {
  fs.rmSync(temporary, { force: true });
}
NODE
}

routekit_print_version() {
  _raw=$(routekit version 2>/dev/null | head -n 1)
  _ver=$(printf '%s\n' "$_raw" | awk '{ print $2 }')
  if [ -n "$_ver" ]; then
    printf '%s\n' "$_ver"
  else
    printf 'unknown\n'
  fi
}

main() {
  set -u
  version=latest
  dry_run=no
  ROUTEKIT_NPM_PREFIX=${ROUTEKIT_NPM_PREFIX:-}
  ROUTEKIT_INSTALL_MODE=
  ROUTEKIT_NPM_EXECUTABLE=
  ROUTEKIT_NODE_EXECUTABLE=

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version)
        if [ "$#" -lt 2 ]; then
          echo "RouteKit installer: --version requires a value" >&2
          return 2
        fi
        version=$2
        shift 2
        ;;
      --prefix)
        if [ "$#" -lt 2 ]; then
          echo "RouteKit installer: --prefix requires a value" >&2
          return 2
        fi
        ROUTEKIT_NPM_PREFIX=$2
        shift 2
        ;;
      --dry-run)
        dry_run=yes
        shift
        ;;
      -h|--help)
        routekit_usage
        return 0
        ;;
      --)
        shift
        break
        ;;
      -*)
        echo "RouteKit installer: unknown option: $1" >&2
        routekit_usage
        return 2
        ;;
      *)
        # Positional version for remote-provision compatibility: bare semver.
        version=$1
        shift
        ;;
    esac
  done

  routekit_validate_version "$version" || return 2
  routekit_ensure_runtime || return 1

  if [ "$dry_run" = "yes" ]; then
    echo "RouteKit installer: would install ${ROUTEKIT_PACKAGE}@${version} (mode=${ROUTEKIT_INSTALL_MODE})" >&2
    return 0
  fi

  routekit_detect
  if [ "$version" != "latest" ] && [ "$routekit_version" = "$version" ]; then
    echo "RouteKit installer: already ${version}" >&2
    routekit_write_install_receipt || return 1
    routekit_print_version
    return 0
  fi

  routekit_install_package "$version" || return 1
  routekit_write_install_receipt || return 1
  routekit_print_version
}

# Invoke main last so a truncated curl|sh download cannot run a partial body.
main "$@"
