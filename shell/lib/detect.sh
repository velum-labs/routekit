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
