# Operations and scripts

This page documents the repository's maintainer automation: root scripts, release state, generated code, CI workflows, dependency policy, local setup, and verification commands.

## Root command model

The root `package.json` is private and defines the Node workspace commands.
Turborepo orchestrates `packages/*` from the root.

| Command | What it does | When to run it |
| --- | --- | --- |
| `pnpm check` | Runs `scripts/check-repo.mjs` and other repository invariant checks. | Before committing package, release, or documentation changes. |
| `pnpm build` | Runs dependency-aware Turbo builds for every package. | After changing Node code. |
| `pnpm build:cli` | Builds `@velum-labs/routekit` and its dependencies through Turbo. | For fast CLI-only rebuilds. |
| `pnpm clean` | Runs each workspace project's clean task through Turbo. | When build output is stale or a package graph changed. |
| `pnpm test` | Runs Turbo package tests with their builds, then root `test/`. | After changing Node behavior. |
| `pnpm test:root` | Runs only the root `test/*.test.js` suites. | For root-level test iteration. |
| `pnpm test:e2e:matrix` | Runs the RouteKit E2E verification matrix. | After gateway, daemon, or CLI orchestration changes. |
| `pnpm verify` | Runs `pnpm check`, `pnpm build`, `pnpm package:lint`, `pnpm package:types`, and `pnpm test`. | Before release or broad behavior changes. |
| `pnpm lint` | Biome lint (includes CLI `noConsole`). | During day-to-day edits; also run from `pnpm check`. |
| `pnpm format` / `pnpm format:write` | Biome format check / write. | Mechanical formatting (separate from lint migration). |
| `pnpm syncpack:lint` | Fails on catalog/version drift. | After changing dependencies; also run from `pnpm check`. |
| `pnpm depcruise` | dependency-cruiser package-boundary rules. | After changing imports; also run from `pnpm check`. |
| `pnpm package:lint` | publint over every publishable package. | After `pnpm build`; part of `pnpm verify` / `pnpm release`. |
| `pnpm package:types` | `@arethetypeswrong/cli` (ESM-only profile) over publishable packages. | After `pnpm build`; part of `pnpm verify` / `pnpm release`. |
| `pnpm dev:link-routekit` | Links the `routekit-dev` wrapper globally. | To run this checkout's CLI from other repos. |
| `pnpm dev:run-routekit` | Rebuilds and runs the local RouteKit CLI. | For dev-loop CLI runs. |
| `pnpm docs:dev` | Generates API markdown then runs the Fumadocs site (`apps/docs`). | Local docs preview. |
| `pnpm docs:build` | Generates API markdown then builds the docs site. | Before shipping docs; not part of default `pnpm verify`. |
| `pnpm docs:generate-code` | Regenerates TypeDoc markdown under gitignored `apps/docs/generated/api/`. | Prestep of `docs:dev` / `docs:build`; not required for `pnpm check`. |
| `pnpm docs:generate-routekit-evidence` | Regenerates L06 evidence artifacts. | After matrix or qualification changes. |
| `pnpm docs:check-routekit-evidence` | Checks committed L06 evidence for drift. | In CI and before publishing evidence updates. |
| `pnpm changeset` | Records release intent with `@changesets/cli`. | Alongside any change that should ship in the next release. |
| `pnpm version-packages` | Consumes pending changesets and updates package versions/changelogs. | Normally run by `changesets/action` in the Version Packages PR. |
| `pnpm release` | Verifies and publishes unpublished package versions with Changesets. | Normally run by `changesets/action` after the Version Packages PR merges. |

## Script reference

### `scripts/check-repo.mjs`

Main repository invariant check. Validates required files, dependency policy,
architecture guards, and optional generated-doc checks.

```bash
pnpm check
```

### Changesets

RouteKit uses the standard `@changesets/cli` and `changesets/action` workflow.
`.changeset/config.json` defines one fixed group containing every workspace
package, so all packages keep one version. The private testkit is versioned but
not published.

```bash
pnpm changeset
```

After changesets merge to `main`, `.github/workflows/release-packages.yml`
creates or updates the Version Packages PR. Merging that PR runs `pnpm release`.

Package changelogs live beside each manifest (for example
`packages/cli/CHANGELOG.md`).

### Check scripts

| Script | Purpose |
| --- | --- |
| `scripts/check-ootb-cli.mjs` | Out-of-the-box shape smoke for the published `routekit` CLI. |
| `scripts/check-routekit-cli-pack.mjs` | Packs and clean-installs the RouteKit dependency closure. |
| `typedoc.json` | On-demand TypeDoc markdown API docs (`pnpm docs:generate-code` → `apps/docs/generated/api/`). |
| `apps/docs` | Public Fumadocs site (`pnpm docs:dev` / `pnpm docs:build`). |
| `scripts/check-publishable-packages.mjs` | publint + attw over publishable packages (`pnpm package:lint` / `pnpm package:types`). |
| `.dependency-cruiser.mjs` | Import-graph boundary rules (`pnpm depcruise`). |
| `.syncpackrc.json` / `pnpm-workspace.yaml` `catalog:` | Dependency pin source of truth + syncpack catalog policy. |
| `biome.json` | Format + lint (CLI `noConsole`). |

### Generator scripts

| Script | Purpose |
| --- | --- |
| `scripts/generate-registry.mjs` | Generates registry bindings from `spec/registry/*.json`. |
| `scripts/generate-shell-scripts.mjs` | Inlines `shell/**/*.sh` into generated CLI assets and `install.sh`. |
| `scripts/generate-node-digests.mjs` | Regenerates pinned Node.js tarball digests. |
| `scripts/generate-pricing.mjs` | Refreshes and validates `spec/registry/pricing.json`. |
| `scripts/generate-local-catalog.mjs` | Refreshes and validates `spec/registry/local-catalog.json`. |
| `scripts/generate-routekit-l06-evidence.mjs` | Promotes matrix reports into durable L06 evidence docs. |
| `scripts/generate-routekit-manual-records.mjs` | Projects reviewed manual records from matrix output. |

### E2E and qualification scripts

| Script | Purpose |
| --- | --- |
| `scripts/routekit-e2e-matrix.mjs` | Credential-free and live RouteKit verification matrix (`pnpm test:e2e:matrix`). |
| `scripts/routekit-qualification.mjs` | L06 route descriptors consumed by the matrix. |
| `scripts/routekit-dev.mjs` | Rebuild-then-run wrapper for this checkout's CLI (`pnpm dev:run-routekit`). |
| `scripts/link-routekit-dev.mjs` | Links `routekit-dev` globally (`pnpm dev:link-routekit`). |

## Release files

| File | Purpose |
| --- | --- |
| `.changeset/config.json` | Fixed lockstep group and Changesets policy. |
| `.changeset/*.md` | Pending release intents recorded with `pnpm changeset`. |
| `packages/*/CHANGELOG.md` | Package changelogs generated in the Version Packages PR. |
| `.github/workflows/release-packages.yml` | Version PR, npm OIDC publish, GitHub releases, and installer asset upload. |

Do not hand-edit package versions. Add a changeset and let the Version Packages
PR apply the release plan.

## Dependency policy

Third-party dependency pins live in the `catalog:` block of
`pnpm-workspace.yaml`. Workspace manifests must reference them with
`"pkg": "catalog:"` (internal packages use `workspace:*`).
`scripts/check-repo.mjs` rejects non-catalog third-party specifiers;
`pnpm syncpack:lint` fails on catalog/version drift.

The `.npmrc` policy uses exact saves, frozen lockfile installs, integrity
verification, script restrictions, and a release-age policy.

When adding a dependency: add the exact pin to the catalog, set the manifest
specifier to `catalog:`, run `pnpm install`, then `pnpm check`.

## CI workflow map

Workflows live under `.github/workflows/`. `ci.yml` runs repository checks, builds, tests, OOTB CLI smoke, and the E2E matrix.

`release-packages.yml` runs Changesets on pushes to `main`: it opens or updates
the Version Packages PR while changesets are pending, then publishes through npm
OIDC after that PR merges.

Common local equivalents:

| CI concern | Local command |
| --- | --- |
| Repository invariants | `pnpm check` |
| TypeScript compile | `pnpm build` |
| Node unit tests | `pnpm test` after build |
| Full TypeScript verify | `pnpm verify` |
| E2E matrix | `pnpm test:e2e:matrix` |

## Local setup notes

The expected Node version is at least the root `engines.node` value, and individual dependencies may require a newer patch version (`>=22.19.0` in practice). Package manager is pnpm 11.15.1 via Corepack.

Run installs at the repository root. Use Turbo filters rather than nested package installs.

For E2E tests that need the provider simulator, install `routekit-sim` on
`PATH`, set `ROUTEKIT_SIM_COMMAND` to the executable, or set
`ROUTEKIT_SIM_ROOT` to a checkout that provides `.venv/bin/routekit-sim` or
`bin/routekit-sim`. Suites self-skip when the simulator is unavailable.

## Documentation operations

Maintainer docs live under `docs/`. For docs-only changes under `docs/`, run
`pnpm check`. Changelog references should point at `packages/cli/CHANGELOG.md`
for the published CLI package.

## Verification strategy

| Changed surface | Minimum verification |
| --- | --- |
| `docs/` only | `pnpm check` |
| TypeScript source | `pnpm build` and focused compiled tests |
| TypeScript source with broad package impact | `pnpm verify` |
| Gateway / daemon / CLI orchestration | `pnpm test:e2e:matrix` |
| Release state | `pnpm changeset status` and `pnpm check` |

## Recovery guidance

If generated files changed unexpectedly, rerun the generator from a clean tree and compare the diff. If output is still unexpected, inspect the generator inputs before editing generated files.

If `pnpm check` fails on architecture guards, read the violation message in `scripts/lib/architecture-guards.mjs` before bypassing a check.

If the E2E matrix self-skips, confirm `uv` is on PATH and `ROUTEKIT_SIM_ROOT` points at a checkout that contains the `routekit-sim` entrypoint.
