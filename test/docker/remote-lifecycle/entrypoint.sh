#!/bin/sh
# Prepare owner/peer SSH homes, npm registry pointers, provider env, then sshd.
set -eu

REGISTRY_URL=${REGISTRY_URL:-}
MOCK_PROVIDER_PORT=${MOCK_PROVIDER_PORT:-17999}
MOCK_PROVIDER_MODEL=${MOCK_PROVIDER_MODEL:-gpt-5.5}
OPENAI_API_KEY=${OPENAI_API_KEY:-docker-e2e-key}
OPENAI_BASE_URL=${OPENAI_BASE_URL:-http://127.0.0.1:${MOCK_PROVIDER_PORT}/v1}
AUTHORIZED_KEYS=${AUTHORIZED_KEYS:-/keys/authorized_keys}

if [ ! -f "$AUTHORIZED_KEYS" ]; then
  echo "routekit-remote-entrypoint: missing authorized keys at $AUTHORIZED_KEYS" >&2
  exit 1
fi

setup_user() {
  _user=$1
  _home=$(getent passwd "$_user" | cut -d: -f6)
  install -d -m 0700 -o "$_user" -g "$_user" "$_home/.ssh"
  install -m 0600 -o "$_user" -g "$_user" "$AUTHORIZED_KEYS" "$_home/.ssh/authorized_keys"

  # Noninteractive SSH sessions read this when PermitUserEnvironment is on.
  {
    printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY"
    printf 'OPENAI_BASE_URL=%s\n' "$OPENAI_BASE_URL"
    printf 'ROUTEKIT_NO_SUPERVISOR=1\n'
    printf 'ROUTEKIT_PORTLESS=0\n'
    printf 'PORTLESS=0\n'
    printf 'NO_COLOR=1\n'
  } >"$_home/.ssh/environment"
  chown "$_user:$_user" "$_home/.ssh/environment"
  chmod 0600 "$_home/.ssh/environment"

  if [ -n "$REGISTRY_URL" ]; then
    {
      printf '@velum-labs:registry=%s\n' "$REGISTRY_URL"
      printf 'registry=%s\n' "$REGISTRY_URL"
      # Local HTTP Verdaccio has no TLS; keep installs deterministic.
      printf 'strict-ssl=false\n'
    } >"$_home/.npmrc"
    chown "$_user:$_user" "$_home/.npmrc"
    chmod 0600 "$_home/.npmrc"
  fi

  # Peers traverse the owner home by absolute path; keep owner list-private.
  if [ "$_user" = "owner" ]; then
    chmod 0751 "$_home"
    install -d -m 0700 -o "$_user" -g "$_user" "$_home/.config/routekit"
    cat >"$_home/.config/routekit/router.yaml" <<EOF
providers:
  openai: {}
defaultModel: openai/${MOCK_PROVIDER_MODEL}
EOF
    chown "$_user:$_user" "$_home/.config/routekit/router.yaml"
    chmod 0600 "$_home/.config/routekit/router.yaml"
  else
    chmod 0750 "$_home"
  fi
}

setup_user owner
setup_user peer

# Mock provider stays on loopback inside the target.
node /usr/local/lib/routekit-mock-provider.mjs \
  >/tmp/mock-provider.log 2>&1 &

exec /usr/sbin/sshd -D -e
