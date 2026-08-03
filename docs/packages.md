# Package guide

The TypeScript workspace is managed by pnpm. Package entry points are generally
`packages/<name>/src/index.ts`; tests live next to source under `src/test`.

This page is the short package guide. For full package ownership, exported
functions and classes, examples, and change guidance, read
[TypeScript reference](typescript-reference.md). Public product docs live under
`apps/docs` (`pnpm docs:dev`). Generated API docs are on-demand TypeDoc output
under gitignored `apps/docs/generated/api/` (`pnpm docs:generate-code`); they
are browsed directly from the checkout and are not routed through the public
Fumadocs site. They are not committed and are not part of `pnpm check`.

## Non-obvious directory to package mappings

Workspace directory names are implementation names, not always npm package
names. Use the manifest name when importing or installing:

| Directory | Published package |
| --- | --- |
| `packages/cli` | `@velum-labs/routekit` |
| `packages/runtime` | `@velum-labs/routekit-runtime` |
| `packages/config` | `@velum-labs/routekit-config` |
| `packages/config-core` | `@velum-labs/routekit-config-core` |
| `packages/router` | `@velum-labs/routekit-router` |
| `packages/gateway` | `@velum-labs/routekit-gateway` |
| `packages/daemon` | `@velum-labs/routekit-daemon` |
| `packages/control` | `@velum-labs/routekit-control` |
| `packages/contracts` | `@velum-labs/routekit-contracts` |
| `packages/accounts` | `@velum-labs/routekit-accounts` |
| `packages/harness-core` | `@velum-labs/routekit-harness-core` (plus `@velum-labs/routekit-harness-core/testing`) |
| `packages/tools` | `@velum-labs/routekit-tools` |
| `packages/registry` | `@velum-labs/routekit-registry` |
| `packages/tracing` | `@velum-labs/routekit-tracing` |
| `packages/telemetry-core` | `@velum-labs/routekit-telemetry-core` |
| `packages/cli-ui` | `@velum-labs/routekit-cli-ui` |
| `packages/cli-core` | `@velum-labs/routekit-cli-core` |
| `packages/testkit` | `@velum-labs/routekit-testkit` (never published) |

## CLI and daemon

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@velum-labs/routekit` | Public `routekit` CLI: singleton lifecycle, configuration, accounts, providers, models, coding-tool launchers, remote gateways, and telemetry. | `packages/cli/src/cli.ts`, `packages/cli/src/commands/index.ts` |
| `@velum-labs/routekit-daemon` | Singleton process: listeners, router generations, drain, and supervisor hooks. | `packages/daemon/src/index.ts` |
| `@velum-labs/routekit-control` | Authenticated control RPC used by the CLI. | `packages/control/src/index.ts` |
| `@velum-labs/routekit-cli-ui` | Brand-configurable Ink/plain presenters, prompts, wizards, and formatting. | `packages/cli-ui/src/index.ts` |
| `@velum-labs/routekit-cli-core` | CLI context, errors, shared option parsing, completion, package versions, and test helpers. | `packages/cli-core/src/index.ts` |

## Routing and gateway

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@velum-labs/routekit-config` | RouterConfig discovery, layered loading, validation, atomic writes, and live-model helpers. | `packages/config/src/index.ts` |
| `@velum-labs/routekit-router` | Embedded RouteKit router composition, account relays, and gateway ownership. | `packages/router/src/index.ts` |
| `@velum-labs/routekit-gateway` | Neutral HTTP gateway, dialect adapters, runtime router/catalog, pooled endpoints, provider egress, and single-call provenance. | `packages/gateway/src/index.ts` |
| `@velum-labs/routekit-accounts` | Subscription credentials, account pooling, provider relays, and connector internals. | `packages/accounts/src/index.ts` |
| `@velum-labs/routekit-contracts` | Shared control and wire types. | `packages/contracts/src/index.ts` |

## Harness and tools

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@velum-labs/routekit-harness-core` | Product-neutral coding-agent driver, event, error, approval, and status contracts; published `./testing` contract helpers. | `packages/harness-core/src/index.ts` |
| `@velum-labs/routekit-tools` | Neutral launcher, canonical-driver, capability registry, launch-context, and disposer lifecycle. | `packages/tools/src/index.ts` |
| `@velum-labs/routekit-tool-registry` | Canonical registry composition for every shipped coding-tool integration. | `packages/tool-registry/src/index.ts` |
| `@velum-labs/routekit-tool-codex`, `@velum-labs/routekit-tool-claude`, `@velum-labs/routekit-tool-cursor`, `@velum-labs/routekit-tool-opencode` | One launcher/serializer and one canonical driver per coding tool. Cursor and OpenCode are retained internal integrations, not public launch surfaces. | `packages/tool-<name>/src/index.ts` |

## Support packages

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@velum-labs/routekit-registry` | Provider catalogs, capabilities, discovery, and pricing used by the routing stack. | `packages/registry/src/index.ts` |
| `@velum-labs/routekit-runtime` | Process supervision, allowlisted child environments, URL/bind safety, cleanup, atomic files, locks, ports, and identity-aware portless registration. | `packages/runtime/src/index.ts` |
| `@velum-labs/routekit-config-core` | Layered config resolution, validated JSON IO, migration, and edit primitives. | `packages/config-core/src/index.ts` |
| `@velum-labs/routekit-telemetry-core` | Parameterized consent, redaction, anonymous events, and bounded shutdown. | `packages/telemetry-core/src/index.ts` |
| `@velum-labs/routekit-tracing` | Generic OpenTelemetry providers, propagation, listeners, and export redaction. | `packages/tracing/src/index.ts` |
| `@velum-labs/routekit-testkit` | E2E matrix tooling (never published): provider simulator handle, door profiles, real coding-agent CLI harnesses, and SSE observation. | `packages/testkit/src/index.ts`, `docs/testing.md` |

All workspace packages version and publish together through Changesets. Package
changelogs live beside each manifest (for example `packages/cli/CHANGELOG.md`).

Retained internal provider backends (for example Google) are non-contractual:
registry presence does not add them to RouteKit's launch support or first-launch
onboarding.
