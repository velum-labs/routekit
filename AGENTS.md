# AGENTS.md

## Cursor Cloud specific instructions

RouteKit is a TypeScript pnpm/Turborepo monorepo: a CLI + singleton daemon that
serves a stable OpenAI-compatible gateway in front of multiple LLM providers.
Standard commands live in `README.md` and root `package.json` scripts
(`check`, `build`, `test`, `verify`); this section only captures non-obvious
caveats.

### Node / toolchain (important)
- The repo needs **Node >= 22.19.0** (`.npmrc` has `engine-strict=true`, and
  `undici@8.5.0` requires it). Package manager is **pnpm 10.33.4** via Corepack
  (pinned in `package.json`).
- Non-login shells on this VM resolve `node` to an older `/exec-daemon/node`
  (v22.14.0), which fails the engine check on `pnpm install`. Login/interactive
  shells (and the startup update script) load `nvm` and select **node v22.22.2**,
  which is correct. If any command hits an engine error, run
  `. "$HOME/.nvm/nvm.sh" && nvm use 22.22.2` first.
- tmux sessions started with a login shell already get the correct node.

### Tests / build
- `pnpm test` runs entirely in Node with **no external services, no network, no
  database** (`PORTLESS=0`). `pnpm check` validates repo/registry invariants.
- The full E2E matrix (`pnpm test:e2e:matrix`) and much of `docs/testing.md`
  reference a Python `fusionkit-sim` simulator + `uv` that live in the **external
  `velum-labs/handoffkit` repo (not present here)**; those suites self-skip when
  `uv`/the sim are absent. Several docs (`docs/testing.md`, `docs/cli.md`,
  `docs/configuration.md`) still describe the parent "FusionKit"; the product in
  this repo is **RouteKit-only**.

### Running the app
- Build first (`pnpm build`), then run the built CLI via
  `node packages/cli/dist/index.js <cmd>` (published bin: `routekit`), or
  `pnpm dev:run-routekit`.
- Lifecycle: `routekit start` launches a **detached singleton daemon** (control
  listener + OpenAI-compatible gateway) per `ROUTEKIT_HOME` (default
  `~/.routekit`); `routekit status` prints the gateway URL (e.g.
  `http://127.0.0.1:8080`); `routekit stop`. Canonical config is global at
  `~/.config/routekit/router.yaml`, not per-project.
- The data gateway requires a bearer token. The owner token lives at
  `$ROUTEKIT_HOME/secrets/data-token` and is also registered in
  `$ROUTEKIT_HOME/secrets/tokens.json`. Named tokens are issued with
  `routekit token issue <label>`; for direct HTTP calls send
  `Authorization: Bearer <token>`.
- The gateway defaults to binding `127.0.0.1:8080`. `--host` can bind
  non-loopback addresses when an auth token is present
  (`assertAuthenticatedBind`). Remote enrollment still requires HTTPS for any
  non-loopback `--url`.
- Startup **fails if any configured provider cannot authenticate or discover
  models**, so only enable providers you can actually reach. To exercise the
  gateway without real keys/egress, point a provider at a local OpenAI-compatible
  mock via its base-URL env override (e.g. `OPENAI_BASE_URL` + `OPENAI_API_KEY`);
  the daemon forwards configured providers' key/base-URL env vars to itself.

### Docker (for testing remote features)
- **Docker CE 28.5.2 is installed** in the VM image. systemd is not active, so
  start the daemon manually each session (it does not auto-start), e.g. in a
  tmux window: `sudo dockerd > /tmp/dockerd.log 2>&1`. It is configured for the
  **`fuse-overlayfs` storage driver** (`/etc/docker/daemon.json`) and
  **iptables-legacy** — both required for docker-in-docker in this VM; do not
  switch them to overlay2/nftables. `ubuntu` is in the `docker` group (takes
  effect in a fresh login shell); otherwise use `sudo docker`.
- If Docker is ever missing on a fresh VM, reinstall `docker-ce`,
  `docker-ce-cli`, `containerd.io`, and `fuse-overlayfs`, then re-apply the
  `daemon.json` + iptables-legacy config above.

### Testing RouteKit remote features over SSH
`routekit remote add <name> --url <gateway> --ssh <host>` SSHes to `<host>` and
issues a named data-plane token via `tokens.issue` over the control relay
(no legacy shared-owner-token fallback), health-checks `<gateway>/health`, then
relays control calls over `ssh <host> routekit --local daemon exec`. Peer
accounts can pass `--join rk1_…` so the SSH account is enrolled as a peer first.
Constraints that matter for a test container:
- The daemon defaults to loopback (`127.0.0.1`); `--url` must be **HTTPS or a
  loopback host**. So run the test container with **`--network host`** (shares
  the host loopback): the container gateway is reachable at
  `http://127.0.0.1:8080` and its sshd at `127.0.0.1:22`. First **stop the host's
  own `routekit` daemon** to free `:8080`.
- SSH must be non-interactive: key auth + a `~/.ssh/config` alias with
  `BatchMode yes`, `StrictHostKeyChecking no`, and the `IdentityFile`.
- Reusable testbed recipe (verified working): image from `node:22-bookworm-slim`
  + `openssh-server` + `npm install -g @velum-labs/routekit` (or the public
  `install.sh` one-liner); inject an SSH pubkey into
  `/root/.ssh/authorized_keys`; entrypoint runs `ssh-keygen -A`, writes
  `~/.config/routekit/router.yaml` (openai provider, `defaultModel
  openai/gpt-4o-mini`), exports `OPENAI_API_KEY` + `OPENAI_BASE_URL` (point at a
  local OpenAI-compatible mock so no real egress is needed), `routekit start`,
  then `exec /usr/sbin/sshd -D`. Then from the host:
  `routekit remote add testvm --url http://127.0.0.1:8080 --ssh testvm`,
  `routekit remote use testvm`, `routekit --remote testvm status`.
