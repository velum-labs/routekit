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
done it: a matching installed version, an existing
`~/.config/routekit/router.yaml`, and a recorded daemon are all reported as
skipped rather than replayed. `--force` reinstalls anyway, and `--dry-run`
probes and prints the plan without changing anything.

Passing `--url` enrolls the host as a remote through the same path `remote add`
uses, naming it after the SSH destination unless `--name` says otherwise. Without
`--url` the command stops at a running daemon and prints the `remote add` to run
once the gateway is reachable over HTTPS.

By default `remote install` installs the same version as the client, so the two
always speak a matching control protocol. `--version <semver|latest>` overrides
that; anything other than an exact release or `latest` is rejected.

### What provisioning will not do

- **No sudo.** Administration runs under `BatchMode=yes`, which cannot answer a
  password prompt. If the global npm prefix is not writable by the SSH user,
  the command fails and asks you to point npm at a user-owned prefix
  (`npm config set prefix ~/.local`) instead of escalating.
- **No Node.js install.** RouteKit needs Node.js 22 or newer. A host without it,
  or with an older major, is rejected before anything is installed. nvm
  installations are found by reading nvm's directory layout, since
  `ssh host <command>` does not run a login shell.
- **No network exposure.** The provisioned daemon binds loopback, exactly as it
  does locally. Terminating TLS and publishing the gateway is the operator's
  job, and `remote add` requires HTTPS for any non-loopback URL.

A freshly provisioned host has no provider credential, so its daemon cannot
start yet. That is reported as a blocked start rather than a failure: the
install succeeded, and the next step is to add a credential on the host
(`ssh velum-mini routekit accounts login codex`) and start it.
