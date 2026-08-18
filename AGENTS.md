# RouteKit agent contract

RouteKit is a TypeScript pnpm/Turborepo monorepo for a CLI and singleton daemon
that expose an authenticated OpenAI-compatible gateway across LLM providers.

## Required verification

- Use Node >= 22.22.0 and pnpm 11.15.1 through Corepack.
- Run `pnpm check` after source, dependency, or architecture changes.
- Run the offline `pnpm test` before declaring work complete. It requires no
  network, database, provider credentials, or external service.
- Run focused package builds and tests while iterating.
- Third-party dependency versions belong in the root catalog; package manifests
  use `catalog:`.

## ENG-814 glossary

- **service** — an Effect-owned capability under
  `src/services/<service>/service.ts`; keep exactly one directory level.
- **store** — durable or in-memory state access, separate from a service unless
  the service owns its lifecycle.
- **protocol** — canonical schemas and wire values shared across a boundary.
- **adapter** — translation between a protocol or platform API and a service.
- **façade** — a thin published root or documented subpath that only re-exports
  its owned public surface.
- **eval-engine** — the offline evaluation implementation in
  `packages/eval-engine`; do not modify it for ENG-814.
- **eval-service** — the Effect composition in `packages/eval-service` and the
  only production owner allowed to compose eval-engine.
- **activation** — the published compositional routing value
  `PublishedRoutingActivation`.
- **profile (deleted)** — the retired v1 routing-profile protocol; do not
  recreate its types, files, or imports.
- **auto** — gateway compositional routing for `model: "auto"`; classifier,
  eval-policy, and activation remain in the gateway path.

See [`docs/internals/glossary.md`](docs/internals/glossary.md) for file links.

## Source conventions

- Keep services in `src/services/<service>/service.ts`; no deeper grouping and
  no `services/index.ts` barrels.
- Internal imports use the precise service file or a named Runtime subpath such
  as `@velum-labs/routekit-runtime/filesystem`; never import through a package's
  own root façade.
- Schemas, protocols, stores, adapters, formatting, and generic utilities are
  not services.
- Prefer `Effect.gen`, named `Effect.fn("Domain.operation")` operations, and
  `Effect.fnUntraced` for reusable internal helpers.
- Expected failures use typed error channels. Effect-owned resources use
  `Effect.acquireRelease`, finalizers, and scoped fibers.
- Raw Node filesystem, process, clock, and HTTP APIs stay at platform adapter
  or application-entry boundaries when an Effect platform service exists.
- Split files only at ownership, lifecycle, protocol, or portability
  boundaries; do not extract single-use helpers to satisfy line-count limits.

## Hard do-nots

- Do not modify `packages/eval-engine`.
- Do not restore `packages/router` unless `pnpm check` or offline tests prove
  `model: "auto"` is broken. Do not delete any other package.
- Do not delete or rewrite gateway classifier, eval-policy, compositional auto
  routing, or `PublishedRoutingActivation`.
- Do not change `control.v2`, HTTP/SSE wire behavior, CLI output, persisted
  formats, or published npm roots except where the task explicitly requires it.
- Do not recreate deleted profile protocol, `apps/eval-worker`, or
  `runEvalSuite`.
- Do not add a parallel manual resource-scope abstraction; the daemon owns
  gateway generations and closeable Effect scopes.

Cloud VM, nvm, Docker, and SSH notes live in [`.cursor/CLOUD.md`](.cursor/CLOUD.md).
