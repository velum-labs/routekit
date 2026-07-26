# include lib/preamble.sh
p() { printf "%s=%s\n" "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }
os=$(uname -s 2>/dev/null || echo unknown)
p os "$os"
p arch "$(uname -m 2>/dev/null || echo unknown)"
if have node; then p node "$(node --version 2>/dev/null || echo unknown)"; else p node ""; fi
if have npm; then p npm "$(npm --version 2>/dev/null || echo unknown)"; else p npm ""; fi
prefix=""
writable=no
if have npm; then
  prefix=$(npm prefix -g 2>/dev/null || echo "")
  if [ -n "$prefix" ]; then
    if [ -w "$prefix/lib/node_modules" ]; then
      writable=yes
    elif [ ! -e "$prefix/lib/node_modules" ] && [ -w "$prefix" ]; then
      writable=yes
    fi
  fi
fi
p npmPrefix "$prefix"
p npmPrefixWritable "$writable"
installed=""
if have routekit; then
  raw=$(routekit version 2>/dev/null | head -n 1)
  # shellcheck disable=SC2086
  set -- $raw
  if [ "$#" -ge 2 ]; then installed=$2; else installed=unknown; fi
fi
p routekit "$installed"
supervisor=none
if [ "$os" = "Darwin" ]; then
  if have launchctl; then supervisor=launchd; fi
elif have systemctl; then
  if systemctl --user show-environment >/dev/null 2>&1; then supervisor=systemd; fi
fi
p supervisor "$supervisor"
if [ -f "$HOME/.config/routekit/router.yaml" ]; then p config yes; else p config no; fi
state=${ROUTEKIT_HOME:-$HOME/.routekit}
if [ -f "$state/services/daemon.json" ]; then p daemon yes; else p daemon no; fi
exit 0
