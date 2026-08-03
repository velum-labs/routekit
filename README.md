# RouteKit

Configure, serve, and use model gateways for coding agents.

## Install the CLI

The published CLI package is `@velum-labs/routekit`; it installs the
`routekit` executable.

```bash
npm install -g @velum-labs/routekit
routekit setup
routekit codex
```

RouteKit runs a singleton daemon for provider discovery, account state, usage,
and the local OpenAI-compatible gateway. Product documentation lives in
`apps/docs/content/docs/`; maintainer documentation lives in `docs/`.

## Develop from source

Use the repository checkout when you are changing packages, docs, release
automation, or tests. The workspace uses Node.js 22.22.0 or newer and pnpm
11.15.1 through Corepack.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
```

Useful focused commands:

```bash
pnpm build:cli
pnpm dev:link-routekit
pnpm docs:dev
pnpm docs:build
pnpm verify
```

`pnpm dev:link-routekit` installs a `routekit-dev` command that runs this
checkout without replacing the published `routekit` binary.

## Repository map

- `packages/cli` publishes `@velum-labs/routekit`, the user-facing CLI.
- `packages/daemon`, `packages/gateway`, and `packages/router` own the daemon,
  HTTP gateway, and reusable router composition.
- `packages/accounts`, `packages/config`, `packages/registry`, and
  `packages/runtime` own provider/account/config/runtime support.
- `packages/tool-*`, `packages/tools`, and `packages/harness-core` own coding
  tool integration boundaries.
- `docs/packages.md` and `docs/typescript-reference.md` are the package-level
  contributor guides.

See `docs/` for routes, billing, configuration, testing, release operations,
and qualification evidence.
