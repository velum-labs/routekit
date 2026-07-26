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

`remote add` retrieves the data-plane credential with the remote CLI and checks
both HTTPS health and SSH control compatibility. SSH access is therefore a hard
requirement for enrollment and administration, but not for later launcher and
model-list operations.

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
- **No network exposure.** The provisioned daemon binds loopback, exactly as it
  does locally. Terminating TLS and publishing the gateway is the operator's
  job, and `remote add` requires HTTPS for any non-loopback URL.

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
