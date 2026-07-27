# RouteKit remote gateways

RouteKit clients can name and select a shared gateway without running a local
daemon. The remote record contains only the HTTPS gateway URL and SSH host;
the data-plane token is stored in macOS Keychain or a private `0600` file on
other platforms.

```bash
routekit remote install velum-mini
routekit remote add mini --url https://your-gateway.example --ssh velum-mini
routekit remote list
routekit remote show mini
routekit remote use mini
routekit remote use --none
routekit remote remove mini
```

Selection precedence is `--local`, then `--remote <name>`, then the active
remote, then the local daemon. `routekit models list` and coding-tool launchers
use the remote HTTPS data plane. Status, config, accounts, providers, usage,
calls, telemetry, and doctor use an SSH relay into the daemon's existing
loopback-only `control.v1` endpoint. The control listener must not be exposed
on the network.

`remote add` issues a named data-plane token over the SSH control relay
(`tokens.issue`, labeled `remote-<name>@<hostname>`) and checks both HTTPS
health and SSH control compatibility. Older remotes without `tokens.issue` fall
back to the shared owner token from `daemon auth show`. SSH access is therefore
a hard requirement for enrollment and administration, but not for later
launcher and model-list operations.

## Multi-user access on one host

A single daemon can serve multiple OS accounts on the same machine (for example
two Tailscale users on `velum-mini`). The owner keeps the daemon under their
`$ROUTEKIT_HOME`; peers enroll with a self-describing join credential that
embeds both the control secret and the path to the owner's secret-free
discovery file.

**Owner (once):**

```bash
# Issue a data-plane token for Bob's laptop (or let remote add do it)
routekit token issue bob@macbook --plane data

# Issue a control-plane join credential so Bob can admin from his OS account
routekit token issue bob-admin --plane control
# prints: routekit peer add rk1_… — hand that line to Bob securely

# Confirm the public discovery file exists
ls -l ~/.routekit/services/daemon.public.json   # 0644, no secrets

# Peers read that file by absolute path, so the home directory above it must be
# traversable. Ubuntu creates home directories as 0750, which blocks them:
chmod o+x ~
```

**Bob on the shared host (his own OS account):**

```bash
# Paste the line the owner printed (no local daemon will be started)
routekit peer add rk1_…
routekit peer show
routekit --local status   # relays through the peer pointer
```

**Bob's laptop:**

```bash
routekit remote add mini --url https://velum-mini.tail….ts.net:8787 --ssh bob@velum-mini
routekit remote use mini
```

Revoke access with `routekit token list` / `routekit token revoke <id>`. The
owner data-plane token cannot be revoked over the control API. Inference calls
carry the token's label in `routekit calls inspect` as `principal`.

The daemon opens `$ROUTEKIT_HOME` and `$ROUTEKIT_HOME/services` to `0711` so
peers can read `daemon.public.json` by exact path; nothing else becomes
readable. Secrets stay `0700`/`0600`, and `services/daemon.json` — which holds
the owner's ephemeral control token — remains `0600`. The join credential
stores the path (not the URL) because the control port is ephemeral; the peer
pointer keeps only the bare secret and re-reads the public record on every
command.

## Provisioning a host

`remote add` expects the host to already run RouteKit. `remote install` gets it
there: it probes the host, installs the CLI from npm, creates the canonical
config, and starts the daemon.

```bash
routekit remote install velum-mini --dry-run
routekit remote install deploy@velum-mini
routekit remote install deploy@velum-mini --url https://your-gateway.example
```

Every step is idempotent, and each one is skipped when the host has already
done it: a matching installed version and an existing
`~/.config/routekit/router.yaml` are reported as skipped rather than replayed.
A daemon that is already running is queried rather than restarted, because
`routekit start` refuses to run against a daemon whose effective listener
options differ from the ones it would ask for. `--force` reinstalls anyway, and
`--dry-run` probes and prints the plan without changing anything.

Passing `--url` enrolls the host as a remote through the same path `remote add`
uses, naming it after the SSH destination unless `--name` says otherwise. Without
`--url` the command stops at a running daemon and prints the `remote add` to run
once the gateway is reachable over HTTPS.

By default `remote install` installs the same version as the client, so the two
always speak a matching control protocol. `--version <semver|latest>` overrides
that; anything other than an exact release or `latest` is rejected.

### What provisioning will not do

- **No sudo.** Administration runs under `BatchMode=yes`, which cannot answer a
  password prompt. When the global npm prefix is not writable, the inlined
  installer falls back to a private Node runtime under
  `~/.local/share/routekit/node` and a user-owned prefix instead of escalating.
- **No unsupported OS.** The private Node bootstrap covers Linux and macOS
  (x64/arm64). Other platforms are rejected before anything is installed. A
  host without Node.js, or with an older major, is fine: the installer
  downloads a pinned Node tarball and verifies it against digests baked into
  the script.
- **No network exposure by default.** The provisioned daemon binds loopback
  (`127.0.0.1`). Non-loopback binds are possible with `--host` once an auth
  token exists, but terminating TLS and publishing the gateway is still the
  operator's job, and `remote add` requires HTTPS for any non-loopback URL.

A freshly provisioned host has no provider credential, so its daemon cannot
start yet. That is reported as a blocked start rather than a failure: the
install succeeded, and the next step is to add a credential on the host
(`ssh velum-mini routekit accounts login codex`) and start it.

## How remote commands resolve RouteKit

`ssh host <command>` does not run a login shell, so anything installed outside
the system prefix is missing from the remote `PATH`. That covers the user-owned
npm prefix this command recommends, along with Homebrew and nvm. Every RouteKit
invocation — provisioning, the token bootstrap, and the `control.v1` relay —
therefore runs under a shared preamble that extends `PATH` and resolves nvm by
reading its directory layout rather than sourcing `nvm.sh`, which is written for
bash and aborts a POSIX shell under the minimal environment non-interactive SSH
provides.

Remote programs live as versioned sources under `shell/` and are inlined at
build time into `packages/cli/src/generated/shell-scripts.ts`. The client
passes each program as a single quoted `sh -c` argument, which keeps stdin free
for the relay's request body. Caller-supplied values are never concatenated
into a program; they arrive as positional parameters and are validated to a
single bare word first. Regenerate with
`node scripts/generate-shell-scripts.mjs` after editing any `shell/**/*.sh`
file; `pnpm check` enforces freshness.
