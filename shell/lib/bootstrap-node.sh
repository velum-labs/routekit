# include lib/node-digests.sh
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
