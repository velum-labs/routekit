# include lib/preamble.sh
# include lib/detect.sh
# include lib/bootstrap-node.sh
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
  ROUTEKIT_NPM_PREFIX=${ROUTEKIT_NPM_PREFIX:-$HOME/.local}
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
    routekit_print_version
    return 0
  fi

  routekit_install_package "$version" || return 1
  routekit_print_version
}

# Invoke main last so a truncated curl|sh download cannot run a partial body.
main "$@"
