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
