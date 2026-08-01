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
| `pnpm docs:dev` | Validates public docs, generates machine-readable indexes, then runs the Fumadocs site (`apps/docs`). | Local docs preview. |
| `pnpm docs:build` | Validates and builds the public Fumadocs site. | Before shipping docs; the docs workspace also builds during the root build. |
| `pnpm docs:generate-code` | Regenerates TypeDoc markdown under gitignored `apps/docs/generated/api/`. | Local symbol review; output is not routed through the public site. |
| `pnpm docs:generate-routekit-evidence` | Regenerates L06 evidence artifacts. | After matrix or qualification changes. |
| `pnpm docs:check-routekit-evidence` | Checks committed L06 evidence for drift. | In CI and before publishing evidence updates. |
| `pnpm changeset` | Records release intent with `@changesets/cli`. | Alongside any change that should ship in the next release. |
| `pnpm version-packages` | Consumes pending changesets and updates package versions/changelogs. | Normally run by `changesets/action` in the Version Packages PR. |
| `pnpm release:artifacts` | Generates the CLI runtime SPDX SBOM and third-party license inventory under `release-artifacts/`. | To inspect the artifacts locally or attach them to a release. |
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

After npm publication, the workflow verifies that the
`@velum-labs/routekit@<version>` tag points at the workflow commit. A matching
tag synchronizes a completed `RouteKit <version>` release to the continuous
`RouteKit npm` Linear pipeline. The sync uses the immediately preceding
RouteKit tag as its exclusive scan base, associates issues found in that exact
commit range, and links the GitHub release and npm package version. GitHub
release notes and package changelogs remain authoritative; the Linear pipeline
does not generate release notes or change issue statuses.

The Linear pipeline access key must be stored in the repository Actions secret
`LINEAR_RELEASE_ACCESS_KEY`. The tag check also makes the operation repairable:
rerunning the workflow for the tagged commit updates the same semver release,
while ordinary `main` pushes and Version Packages PR updates skip the sync.

### Check scripts

| Script | Purpose |
| --- | --- |
| `scripts/check-ootb-cli.mjs` | Out-of-the-box shape smoke for the published `routekit` CLI. |
| `scripts/check-routekit-cli-pack.mjs` | Packs and clean-installs the RouteKit dependency closure. |
| `typedoc.json` | On-demand TypeDoc markdown API docs (`pnpm docs:generate-code` → `apps/docs/generated/api/`). |
| `apps/docs` | Public Fumadocs site (`pnpm docs:dev` / `pnpm docs:build`). |
| `docs/public-documentation-maintenance.md` | Product-to-page ownership matrix and release-time public docs checklist. |
| `scripts/check-publishable-packages.mjs` | publint + attw over publishable packages (`pnpm package:lint` / `pnpm package:types`). |
| `.dependency-cruiser.mjs` | Import-graph boundary rules (`pnpm depcruise`). |
| `.syncpackrc.json` / `pnpm-workspace.yaml` `catalog:` | Dependency pin source of truth + syncpack catalog policy. |
| `biome.json` | Format + lint (CLI `noConsole`). |

### Generator scripts

| Script | Purpose |
| --- | --- |
| `scripts/generate-registry.mjs` | Generates registry bindings from `spec/registry/*.json`. |
| `scripts/generate-shell-scripts.mjs` | Inlines `shell/**/*.sh` into generated CLI assets and `install.sh`. |
| `scripts/generate-release-artifacts.mjs` | Generates the release SPDX SBOM and deterministic third-party license inventory. |
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
| `.github/workflows/release-packages.yml` | Version PR, npm OIDC publish, GitHub and Linear releases, and installer asset upload. |

Do not hand-edit package versions. Add a changeset and let the Version Packages
PR apply the release plan.

### SBOM and third-party license artifacts

Generate release artifacts for the current CLI version with:

```bash
pnpm release:artifacts
```

For an exact release build, pin all provenance inputs explicitly:

```bash
pnpm release:artifacts --version 0.16.4 \
  --source-sha 0123456789abcdef0123456789abcdef01234567 \
  --generated-at 2026-07-28T12:34:56.000Z
```

The command installs the exact published CLI version into an isolated npm tree,
then writes `routekit-<version>.spdx.json`, an SPDX 2.3 document for that
consumer-visible production dependency closure, and
`routekit-<version>-licenses.json`, a sorted
third-party inventory with dependency depth, direct/transitive scope, package
URLs, source URLs, SHA512 checksums, license counts, and per-package policy
results. Both files include the exact package version, release tag, source SHA,
and generation time. `release-artifacts/` is gitignored.

The license policy permits Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC,
0BSD, Unlicense, CC0-1.0, and SPDX `OR` expressions composed only of those
licenses. Missing, `NONE`, or `NOASSERTION` metadata fails generation except for
explicitly reviewed Anthropic Claude Agent SDK and OpenAI Codex optional client
packages. Those entries retain the upstream value, are marked as reviewed
exceptions, and state that separate or commercial terms still require manual
review. Copyleft and every other unapproved license fail with package/version
diagnostics.

After `@velum-labs/routekit` is actually published, the release workflow
regenerates both files for the published version and the workflow commit SHA,
then uploads those exact-version artifacts together with `install.sh` to the
`@velum-labs/routekit@<version>` GitHub release.

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
OIDC after that PR merges. On the tagged publish commit it also synchronizes the
completed semver release to Linear. A failed Linear sync fails the workflow for
visibility, but the non-cancelled artifact repair step still runs; rerun the
same tagged commit after correcting the Linear pipeline or secret.

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
