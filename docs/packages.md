# Package guide

The TypeScript workspace is managed by pnpm. Published package roots are thin
re-export façades; tests live next to source under `src/test`. Internal modules
use precise sibling files or named package subpaths instead of package roots.

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
| `packages/eval-contracts` | `@velum-labs/routekit-eval-contracts` |
| `packages/eval-core` | `@velum-labs/routekit-eval-core` |
| `packages/eval-engine` | `@velum-labs/routekit-eval-engine` |
| `packages/eval-service` | `@velum-labs/routekit-eval-service` |
| `packages/eval-setup` | `@velum-labs/routekit-eval-setup` |
| `packages/eval-store` | `@velum-labs/routekit-eval-store` |
| `packages/cli-ui` | `@velum-labs/routekit-cli-ui` |
| `packages/cli-core` | `@velum-labs/routekit-cli-core` |
| `packages/testkit` | `@velum-labs/routekit-testkit` (never published) |

## CLI and daemon

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@velum-labs/routekit` | Public `routekit` CLI: singleton lifecycle, configuration, accounts, providers, models, coding-tool launchers, remote gateways, and telemetry. | `packages/cli/src/cli.ts`, `packages/cli/src/commands/index.ts` |
| `@velum-labs/routekit-daemon` | Singleton cluster host, rollable worker, listeners, router generations, drain, and supervisor hooks. | `packages/daemon/src/index.ts` |
| `@velum-labs/routekit-control` | Authenticated control RPC used by the CLI. | `packages/control/src/index.ts` |
| `@velum-labs/routekit-cli-ui` | Brand-configurable Ink/plain presenters, prompts, wizards, and formatting. | `packages/cli-ui/src/index.ts` |
| `@velum-labs/routekit-cli-core` | CLI context, errors, shared option parsing, completion, package versions, and test helpers. | `packages/cli-core/src/index.ts` |

## Routing and gateway

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@velum-labs/routekit-config-core` | Canonical RouterConfig schemas, defaults, parsing, normalization, and reusable configuration primitives. | `packages/config-core/src/index.ts` |
| `@velum-labs/routekit-config` | RouterConfig YAML discovery, layered loading, atomic writes, and live-model helpers. | `packages/config/src/index.ts` |
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

## Evaluation

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@velum-labs/routekit-eval-contracts` | Canonical evaluation schemas and the published routing activation protocol. | `packages/eval-contracts/src/index.ts` |
| `@velum-labs/routekit-eval-core` | Evidence scoring and routing selection primitives; it does not own an evaluation runner. | `packages/eval-core/src/index.ts` |
| `@velum-labs/routekit-eval-engine` | Offline evaluation implementation, consumed in production only by eval-service. | `packages/eval-engine/src/index.ts` |
| `@velum-labs/routekit-eval-service` | Effect composition for manifest validation, estimates, comparisons, evidence, and atomic activation publication. | `packages/eval-service/src/service.ts` |
| `@velum-labs/routekit-eval-setup` | Agent-assisted setup and approval workflow for repository evaluation artifacts. | `packages/eval-setup/src/service.ts` |
| `@velum-labs/routekit-eval-store` | Evaluation result and activation stores. | `packages/eval-store/src/store.ts`, `packages/eval-store/src/routing-activation.ts` |

## Support packages

| Package | Responsibility | Start with |
| --- | --- | --- |
| `@velum-labs/routekit-registry` | Provider catalogs, capabilities, discovery, and pricing used by the routing stack. | `packages/registry/src/index.ts` |
| `@velum-labs/routekit-runtime` | Process supervision, allowlisted child environments, URL/bind safety, cleanup, atomic files, locks, ports, and identity-aware portless registration. | `packages/runtime/src/index.ts` |
| `@velum-labs/routekit-config-core` | Canonical RouterConfig schemas and defaults, layered config resolution, validated JSON IO, and edit primitives. | `packages/config-core/src/index.ts` |
| `@velum-labs/routekit-telemetry-core` | Parameterized consent, redaction, anonymous events, and bounded shutdown. | `packages/telemetry-core/src/index.ts` |
| `@velum-labs/routekit-tracing` | Generic OpenTelemetry providers, propagation, listeners, and export redaction. | `packages/tracing/src/index.ts` |
| `@velum-labs/routekit-testkit` | E2E matrix tooling (never published): provider simulator handle, door profiles, real coding-agent CLI harnesses, and SSE observation. | `packages/testkit/src/index.ts`, `docs/testing.md` |

All workspace packages version and publish together through Changesets. Package
changelogs live beside each manifest (for example `packages/cli/CHANGELOG.md`).

Retained internal provider backends (for example Google) are non-contractual:
registry presence does not add them to RouteKit's launch support or first-launch
onboarding.

## Intentional package subpaths

| Package | Subpaths |
| --- | --- |
| `@velum-labs/routekit-contracts` | `./model`, `./reasoning`, `./harness` |
| `@velum-labs/routekit-runtime` | `./args`, `./capacity`, `./control`, `./effect`, `./environment`, `./filesystem`, `./formatting`, `./lifecycle`, `./logging`, `./network`, `./ports`, `./process`, `./service`, `./sse`, `./timing`, `./tokens` |
| `@velum-labs/routekit-control` | `./protocol`, `./registry` |
| `@velum-labs/routekit-config-core` | `./router` |
| `@velum-labs/routekit-accounts` | `./pool`, `./relay` |
| `@velum-labs/routekit-gateway` | `./protocol`, `./routing`, `./server` |
| `@velum-labs/routekit-daemon` | `./effect`, `./state` |
| `@velum-labs/routekit-eval-core` | `./effect` |
| `@velum-labs/routekit-eval-engine` | `./authoring` |
| `@velum-labs/routekit-eval-service` | `./effect` |
| `@velum-labs/routekit-eval-setup` | `./effect` |
| `@velum-labs/routekit-eval-store` | `./effect` |
| `@velum-labs/routekit-harness-core` | `./lifecycle`, `./testing` |
| Tool integration packages | `./driver`, `./launch`; Codex and Claude also publish `./install` |

These exports are intentional surfaces. Production modules inside a package
import sibling implementation files directly; dependency-cruiser rejects
imports through that package's own root façade. Production consumers of Runtime
use a named Runtime subpath.
