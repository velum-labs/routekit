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
- The data gateway requires a bearer token stored at
  `$ROUTEKIT_HOME/secrets/data-token`; for direct HTTP calls send
  `Authorization: Bearer <token>`.
- Startup **fails if any configured provider cannot authenticate or discover
  models**, so only enable providers you can actually reach. To exercise the
  gateway without real keys/egress, point a provider at a local OpenAI-compatible
  mock via its base-URL env override (e.g. `OPENAI_BASE_URL` + `OPENAI_API_KEY`);
  the daemon forwards configured providers' key/base-URL env vars to itself.
