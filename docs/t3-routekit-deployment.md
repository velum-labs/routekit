# T3 Code on a RouteKit gateway

The repository provides an operator deployment for a durable, per-user T3 Code
server on a **macOS or Linux** host. It is intentionally a repository script rather
than a published `routekit t3` command.

```sh
# This Mac: T3 uses the named RouteKit remote "mini" by default.
# Quit T3 Code first; deploy also registers velum-mini in its desktop catalog.
pnpm t3:deploy -- --local

# velum-mini: T3 uses that Mac's local RouteKit gateway by default.
pnpm t3:deploy -- --ssh velum-mini

# Headless, per-user service: SSH as root (or an account with passwordless
# root sudo), but run T3 and every user-scoped command as benjamin.
pnpm t3:deploy -- --ssh root@velum-mini \
  --headless --sudo-user benjamin \
  --deployment-id benjamin --port 3774

# Override the default topology only when explicitly needed.
pnpm t3:deploy -- --ssh t3-host --routekit-remote gateway-prod

# Linux: defaults to the SSH account, or explicitly selects a service user.
pnpm t3:deploy -- --ssh alice@t3-host \
  --service-user alice --routekit-remote gateway-prod

# Add projects to this user's normal T3 state.
pnpm t3:deploy -- --ssh velum-mini \
  --project /Users/alen/Documents/Development/routekit

pnpm t3:destroy -- --local
pnpm t3:destroy -- --ssh velum-mini
pnpm t3:destroy -- --ssh root@velum-mini \
  --headless --sudo-user benjamin --deployment-id benjamin
pnpm t3:destroy -- --ssh alice@t3-host --service-user alice
```

## What it creates

For the default deployment ID, the target receives only these deployment-owned
resources:

- `~/Library/LaunchAgents/com.velum.routekit.t3.default.plist`;
- `~/.routekit/t3/default/run-t3.sh` and its launch logs;
- a hash-tracked shim at the installed global `t3` executable path, with the
  original package symlink recorded for exact restoration;
- RouteKit-owned provider settings at `~/.t3/userdata/settings.json`;
- a private, no-secret manifest at
  `~/.routekit/t3/deployments/default.json`;
- two named RouteKit **data-plane** service tokens;
- two matching macOS Keychain records under service `routekit-t3`.

With `--headless`, the corresponding resources differ in three deliberate
ways:

- the root-owned, non-secret service plist is
  `/Library/LaunchDaemons/com.velum.routekit.t3.<id>.plist` and declares the
  `--sudo-user` account as `UserName`;
- the two plaintext tokens are separate `0600` files owned by that user under
  `~/.routekit/t3/<id>/credentials/`, because a LaunchDaemon has no login
  Keychain session;
- the wrapper and SSH launcher shim read only those credential files and do
  not publish tokens into a global or GUI launchd environment.

The privileged streamed helper resolves the target account through macOS,
checks its UID, GID, home ownership, and manifest identity, then drops every
RouteKit, npm, T3, Codex, and Claude subprocess to that UID/GID. Root privileges
are used for the exact hash-tracked system plist; user assets are private and
owned by the target account. Headless mode requires an SSH root login or
passwordless root `sudo`; `--sudo-user` itself is never treated as permission
to run T3 as root.

On Linux, `--service-user` defaults to the SSH account. When it names another
account, the entrypoint uses passwordless `sudo -u` and the helper verifies the
resolved non-root identity. Linux uses T3's native `t3 service install` user
unit and lingering. RouteKit adds only:

- `~/.config/systemd/user/t3code.service.d/routekit.conf`, a token-free,
  hash-tracked drop-in;
- `~/.routekit/t3/<id>/t3.env`, a user-owned `0600` environment file;
- the same ownership-guarded T3 settings and deployment token records; and
- a persistent Tailscale Serve mapping from private HTTPS 443 to loopback
  `127.0.0.1:3773`.

The native systemd unit remains free of tokens and absolute credential values.
Linux deployment currently uses T3's canonical port `3773`; non-default
`--port` values are rejected.

## Connecting from another Mac

The headless server remains loopback-only on the mini. A user whose Tailscale
identity is allowed to SSH as the deployment user can forward it without root
access. For the `benjamin` deployment on remote port `3774`, run this on the
laptop and leave the terminal open:

```sh
ssh -NT \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -L 4774:127.0.0.1:3774 \
  benjamin@velum-mini
```

Then, from another terminal:

```sh
curl -fsS -o /dev/null -w 'T3 HTTP %{http_code}\n' \
  http://127.0.0.1:4774/health
open http://127.0.0.1:4774
```

The expected health result is `T3 HTTP 200`. Press Control-C in the tunnel
terminal to disconnect. Choose another unused laptop-side port in place of
`4774` if needed; the right side of `-L` must remain
`127.0.0.1:3774`. If the short MagicDNS name is unavailable, use the mini's
full Tailscale DNS name in its place.

Codex and Claude Code are installed on the mini, not on the connecting laptop.
To start either native client directly over SSH with RouteKit injecting its
gateway credential, use:

```sh
ssh -t benjamin@velum-mini \
  'cd "$HOME" && env PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" routekit --local codex'

ssh -t benjamin@velum-mini \
  'cd "$HOME" && env PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" routekit --local claude'
```

These commands do not copy gateway tokens to the laptop. The RouteKit launcher
supplies credentials only to the remote native-client process.

For `--local`, deployment also opens T3 Code through a temporary loopback-only
desktop debugging channel and uses T3's own Connections UI to register and
verify the `velum-mini` SSH environment. T3 encrypts the resulting connection
catalog and credential using its normal desktop storage. The temporary channel
is removed by restarting T3 Code normally before deployment returns.

The managed service listens only on `127.0.0.1:3773` by default, the standard T3
desktop/server endpoint. Use `--port` only when an alternate loopback endpoint
is explicitly required. If the selected port already has a verified T3
listener, deploy stops that T3 process before starting the managed one; it
never replaces a non-T3 listener.

T3 desktop SSH environments can start another loopback server on a different
port. Their generated launcher resolves the global `t3` executable but does
not inherit the GUI LaunchAgent environment. The deployment-owned global shim
reads either the four RouteKit and Claude variables already published in the
user's GUI `launchd` domain (LaunchAgent mode), or the deployment-owned `0600`
credential files (headless mode), exports them to that SSH-launched T3 process,
and then executes the original package entry. It contains no credential values.
Deploy refuses a non-symlinked or already-replaced global executable instead
of adopting it.

The server uses T3's normal `~/.t3` base directory and explicitly preserves the
user’s main `$HOME`; it does not set T3’s `homePath` override for either
provider. Codex therefore uses its normal `$HOME/.codex` home and Claude Code
uses its normal `$HOME/.claude` configuration. This keeps existing MCPs,
skills, client settings, auth, histories, and project configuration available
to both harnesses.

The standard T3 data directory receives a managed, no-secret `settings.json`
that enables normal Codex and Claude providers without a custom home override,
and adds the current RouteKit catalog as T3 model choices.
Codex also discovers its generated RouteKit catalog through the app server.
Claude entries use RouteKit's native `anthropic.routekit.<route>` IDs. Deploy
never deletes `~/.t3`: it preserves T3's chat database, sessions, keys, and
other user data while replacing only the RouteKit-owned provider settings. A
changed active deployment setting is rejected; destroy and redeploy to produce
the canonical configuration.

macOS deployment manifest version 5 records the launchd service mode and, for a
LaunchDaemon, the resolved target user identity. Versions 3 and 4 remain
readable for existing LaunchAgent deployments; a version 3 deployment must be
destroyed and redeployed once to gain the managed SSH launcher shim.
Linux uses a separate version 1 manifest ending in `.linux.json` so the two OS
ownership models cannot be confused.

## Preconditions

On the target, RouteKit must already be configured, running, healthy, and have
a nonempty live catalog. Codex and Claude Code must already be installed. The
script checks these facts before changing anything and never configures
providers, accounts, or RouteKit remotes.

The LaunchDaemon makes T3 independent of a macOS GUI login. It does not migrate
or supervise the selected RouteKit daemon: that gateway must independently be
available after boot for T3 provider requests to succeed.

For `--routekit-remote`, the named remote must already exist in the T3 host's
RouteKit remote registry. The script does not add, activate, edit, or remove a
remote. RouteKit service-token commands honor the selected named remote.

T3 is pinned to `0.0.31`. If T3 is absent, deployment installs that exact global
package. A different existing T3 version fails unless the operator explicitly
passes both `--upgrade-t3 --yes`. Destroy never uninstalls the global T3 package.

On Linux, `t3`, Codex, Claude Code, RouteKit, a working systemd user manager,
and Tailscale must be installed. The AWS stack pins these binaries before
provisioning. Before changing user state, deploy verifies systemd lingering and
enables it through passwordless `sudo` when needed; the SSH account therefore
needs that narrow privilege (the AWS stack's operator account already has it).
The invoking service user must be the Tailscale operator so the helper can
create and remove only its HTTPS Serve mapping.

Quit T3 Code before macOS `--local`. Updating its encrypted desktop connection
catalog requires a controlled app launch; deployment refuses to terminate an
already-running app because that could interrupt an active agent session.

## Harness integration and credentials

The deployment validates an existing RouteKit Codex/Claude integration and
leaves it alone. If neither integration exists, it uses:

```sh
routekit codex install --no-token
routekit claude install --no-token
```

`--no-token` writes only RouteKit-owned client configuration: it never issues,
rotates, revokes, persists, or registers a native client credential. The
deployment then issues separate, exactly-labelled service tokens and stores the
plaintext only in Keychain for LaunchAgent mode, or in the two user-owned
`0600` files described above for headless mode. Each new deployment adds a
cryptographic ownership nonce to its labels, so interrupted-deployment recovery
cannot mistake a user-created token for one of its own. The launch wrapper
retrieves those tokens at start.

On a macOS SSH target, `security` normally defaults to the System keychain and
cannot access the logged-in user's login keychain. The deployment uses a
short-lived, GUI-domain LaunchAgent with a one-shot loopback capability solely
to add, read, or delete its own Keychain record. The temporary script, plist,
launchd arguments, result file, and deployment manifest contain no gateway
token; the bridge is unloaded and removed before each operation returns.

Codex needs its RouteKit model provider selected when T3 starts `codex
app-server`. The script reads the RouteKit-generated `routekit` profile and
sets T3's documented `T3CODE_CODEX_LAUNCH_ARGS` override with the generated
model, provider, and model-catalog values. Claude receives the same deployment
credential as `ANTHROPIC_AUTH_TOKEN` plus the RouteKit `ANTHROPIC_BASE_URL`.
The managed LaunchAgent also publishes the required RouteKit and Claude
variables into the user's launchd environment, so the T3 Code desktop app's
own backend receives them when it launches provider CLIs. No token is written
to a Codex, Claude, T3, shell, plist, or manifest file.

Headless mode intentionally does not use the GUI Keychain bridge or
`launchctl setenv`. Its credential files are the only additional secret-bearing files;
their paths and hashes, but never their contents, are tracked by the deployment.

An existing RouteKit config block without the matching native integration
registry entry is treated as manual/untracked and deployment stops without
modifying it. This prevents accidental takeover of a hand-managed setup.

## Verification

Deployment verifies, without submitting an inference request:

1. the selected RouteKit daemon is healthy and has live models;
2. Codex and Claude binaries execute their version commands;
3. T3 starts through launchd or its native Linux systemd user unit and answers `GET /health` on loopback;
4. each deployment-specific token can list models on the RouteKit gateway.
5. for `--local`, T3 Code persists and connects the `velum-mini` SSH environment.
6. on macOS, the installed SSH launcher shim still matches its deployment-recorded hash;
7. on Linux, the unit drop-in and `0600` environment file match the manifest
   and persistent Tailscale Serve reaches the same loopback service.

Those checks prove the installation, service credential, gateway, and T3
startup paths. They deliberately do not send a billed model request. Run a
normal T3 session after deploy when you want an end-to-end provider inference.

## Destruction safety

`pnpm t3:destroy` removes all deployment-owned assets recorded in the manifest after proving
all of the following:

- the wrapper and plist still hash exactly to the manifest contents;
- each Keychain entry or headless credential file still hashes to its
  deployment-issued token;
- the RouteKit token ID, label, and `createdBy` value exactly match the
  manifest.
- the global T3 shim matches its recorded hash; destroy then restores the exact
  original package symlink and verifies its resolved package entry.
- on Linux, the environment file, drop-in, provider settings, tokens, and any
  deployment-created native unit still match their recorded hashes.

A mismatch stops with no destructive action. Destroy never runs RouteKit config
init/import, provider/account mutations, remote add/remove, native
integration uninstall, `routekit stop`, or `npm uninstall`. It keeps the
T3 chats/sessions and other user data, the RouteKit configuration and daemon,
all Codex/Claude configuration, and the global T3 package. It removes only the
hash-verified RouteKit T3 settings file, wrapper, launchd service, credentials,
logs, shim, and manifest, restoring the original global T3 package symlink. A
later deploy is always a fresh deployment.

On Linux, destroy also removes the deployment's HTTPS Serve mapping. It runs
`t3 service uninstall` only when the manifest proves this deployment created
the native unit; a pre-existing T3 unit is preserved and restarted after the
RouteKit drop-in is removed. The persistent home volume and normal T3, Codex,
Claude, Git, and project state remain intact.

Interrupted deployments write a staging manifest before issuing a token. A
retry can revoke only exactly-labelled staging tokens and remove only
hash-verified deployment assets; it still never removes harness integration
configuration.
