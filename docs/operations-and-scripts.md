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
| `pnpm tsgo:patch` | Patches the isolated `tooling/tsgo` TypeScript 7 compiler with the Effect language service. | After `pnpm install` (prepare hooks are disabled). |
| `pnpm verify` | Runs `pnpm check`, `pnpm build`, `pnpm package:lint`, `pnpm package:types`, and `pnpm test`. | Before release or broad behavior changes. |
| `pnpm lint` | Biome lint (includes CLI `noConsole`). | During day-to-day edits; also run from `pnpm check`. |
| `pnpm format` / `pnpm format:write` | Biome format check / write. | Mechanical formatting (separate from lint migration). |
| `pnpm syncpack:lint` | Fails on catalog/version drift. | After changing dependencies; also run from `pnpm check`. |
| `pnpm depcruise` | dependency-cruiser package-boundary rules. | After changing imports; also run from `pnpm check`. |
| `pnpm package:lint` | publint over every publishable package. | After `pnpm build`; part of `pnpm verify` / `pnpm release`. |
| `pnpm package:types` | `@arethetypeswrong/cli` (ESM-only profile) over publishable packages. | After `pnpm build`; part of `pnpm verify` / `pnpm release`. |
| `pnpm release:registry:preflight` | Verifies that every public workspace package name already exists on npm before OIDC publication starts. | Before publishing a version that introduces a public workspace package; prevents a partially published fixed release. |
| `pnpm release:registry:verify` | Verifies that npm exposes every public workspace package at its exact checkout version. | After Changesets publication and before release artifacts, Linear synchronization, or docs promotion. |
| `corepack pnpm dev:link-routekit` | Links the `routekit-dev` wrapper globally through the repository-pinned pnpm. | To run this checkout's CLI from other repos. |
| `corepack pnpm dev:run-routekit` | Rebuilds and runs the local RouteKit CLI with pinned pnpm in the complete Turbo process tree. | For dev-loop CLI runs. |
| `pnpm t3:deploy` / `pnpm t3:destroy` | Manages ownership-guarded macOS launchd or Linux systemd T3 services. | For operator-managed T3 hosts. |
| `pnpm docs:dev` | Validates public docs, generates machine-readable indexes, then runs the Fumadocs site (`apps/docs`). | Local docs preview. |
| `pnpm docs:build` | Validates and builds the public Fumadocs site. | Before shipping docs; the docs workspace also builds during the root build. |
| `pnpm docs:generate-public-changelog` | Regenerates the public changelog from `packages/cli/CHANGELOG.md`. | For an explicit local refresh; `pnpm version-packages` runs it automatically. |
| `pnpm docs:generate-code` | Regenerates TypeDoc markdown under gitignored `apps/docs/generated/api/`. | Local symbol review; output is not routed through the public site. |
| `pnpm docs:generate-routekit-evidence` | Regenerates L06 evidence artifacts. | After matrix or qualification changes. |
| `pnpm docs:check-routekit-evidence` | Checks committed L06 evidence for drift. | In CI and before publishing evidence updates. |
| `pnpm changeset` | Records release intent with `@changesets/cli`. | Alongside any change that should ship in the next release. |
| `pnpm version-packages` | Consumes pending changesets, updates package versions/changelogs, and regenerates the public changelog. | Normally run by `changesets/action` in the Version Packages PR. |
| `pnpm release:artifacts` | Generates the CLI runtime SPDX SBOM and third-party license inventory under `release-artifacts/`. | To inspect the artifacts locally or attach them to a release. |
| `pnpm release` | Verifies and publishes unpublished package versions with Changesets. | Normally run by `changesets/action` after the Version Packages PR merges. |

## Script reference

### AWS production stack

The secret-free four-node Terraform stack, workload identity policy example,
fenced gateway failover command, Linux T3 workflow, restore drills, and safe
destruction procedure are documented in
[`docs/aws-production-deployment.md`](aws-production-deployment.md).

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
creates or updates the Version Packages PR with `pnpm version-packages`, which
also regenerates the public changelog. Merging that PR runs `pnpm release`.

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

The same verified-release gate refreshes and promotes the public Fumadocs site.
The Vercel Git integration remains enabled for automatic feature-branch and PR
previews. `apps/docs/vercel.json` sets `github.autoAlias` to `false`, so a
`main` merge still gets a Vercel preview deployment but cannot replace the
public site. In the Vercel dashboard, also disable **Auto-assign Custom
Production Domains** under the Production environment; that is Vercel's current
recommended setting for staged production deployments.

Production documentation can also be published without an npm release. Run the
**Publish documentation** workflow from `main`, then approve its
`docs-production` environment deployment. The workflow rejects every other
branch before requesting approval. This manual path only deploys the docs; it
does not create package versions, npm publishes, tags, GitHub releases, or
Linear releases.

Verified releases and approved manual publishes both call
`.github/actions/deploy-docs/action.yml`. The shared action uses the official
Vercel CLI to stage a fresh production deployment with `--skip-domain`, verify
the returned deployment URL, and promote that exact deployment to
`routekit.velum-labs.com`. Both workflows use the `docs-production` concurrency
group, so only one production promotion runs at a time. Release-triggered
publishes remain automatic; only the manual workflow uses the
`docs-production` environment approval gate.

Configure one repository Actions secret:

| Secret | Purpose |
| --- | --- |
| `VERCEL_TOKEN` | Vercel token permitted to link, deploy, and promote the docs project. |

Configure the non-sensitive project selectors as repository Actions variables:

| Variable | Purpose |
| --- | --- |
| `VERCEL_DOCS_PROJECT` | Name or ID of the existing Git-connected docs project. |
| `VERCEL_TEAM` | Vercel team slug or ID that owns the docs project. |

Configure a GitHub environment named `docs-production` with required reviewers
and a deployment branch rule that permits only `main`. Keep `VERCEL_TOKEN` as a
repository secret because the automatic release workflow also needs it; do not
duplicate it as an environment-only secret.

The workflow runs `vercel link --team ... --project ...` non-interactively, so
`VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` do not need to be copied into GitHub
secrets or committed in `.vercel/project.json`. CLI authentication still
requires `VERCEL_TOKEN`; Vercel does not currently document GitHub Actions OIDC
as an authentication method for Vercel CLI deployments.

Production Vercel environment variables should include
`NEXT_PUBLIC_DOCS_URL=https://routekit.velum-labs.com`. Preview deployments
fall back to their Vercel deployment URL.

The shared action deploys from the repository root so the docs build can read
workspace sources such as `packages/cli/package.json` and
`packages/cli/CHANGELOG.md`. `--force` guarantees a fresh build,
`--skip-domain` keeps the successful build staged, and `vercel promote` moves
the domains only after the deployment is ready. Keep the Vercel project's Root
Directory set to `apps/docs` and enable **Include source files outside of the
Root Directory in the Build Step** so the workspace package metadata and
changelog are available during the build.

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
| `scripts/run-turbo.mjs` | Runs Turbo with the repository-pinned pnpm on the complete child-process path. |
| `scripts/routekit-dev.mjs` | Rebuild-then-run wrapper for this checkout's CLI (`corepack pnpm dev:run-routekit`). |
| `scripts/link-routekit-dev.mjs` | Links `routekit-dev` globally (`corepack pnpm dev:link-routekit`). |

## Release files

The npm release workflow uses OIDC trusted publishing. A newly introduced
public workspace package must first be created on npm with maintainer
credentials, then configured with `.github/workflows/release-packages.yml` as
its trusted publisher. Do this before merging the version-packages PR.
`pnpm release:registry:preflight` fails before publication when a package name
has not been bootstrapped, and `pnpm release:registry:verify` prevents
post-release automation from treating a partial fixed-group publication as a
complete RouteKit release.

| File | Purpose |
| --- | --- |
| `.changeset/config.json` | Fixed lockstep group and Changesets policy. |
| `.changeset/*.md` | Pending release intents recorded with `pnpm changeset`. |
| `packages/*/CHANGELOG.md` | Package changelogs generated in the Version Packages PR. |
| `.github/workflows/release-packages.yml` | Version PR, npm OIDC publish, GitHub and Linear releases, installer assets, and automatic docs promotion. |
| `.github/workflows/publish-docs.yml` | Main-only, approval-gated manual production docs publishing. |
| `.github/actions/deploy-docs/action.yml` | Shared staged Vercel deployment and promotion logic. |

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

`publish-docs.yml` is a dispatch-only production path for documentation changes
that should not create an npm release. It accepts only `main`, waits for the
`docs-production` environment approval, and uses the same serialized Vercel
promotion action as verified releases.

Common local equivalents:

| CI concern | Local command |
| --- | --- |
| Repository invariants | `pnpm check` |
| TypeScript compile | `pnpm build` |
| Node unit tests | `pnpm test` after build |
| Full TypeScript verify | `pnpm verify` |
| E2E matrix | `pnpm test:e2e:matrix` |

## Local setup notes

The expected Node version is the root `engines.node` value, currently `>=22.22.0`. Package manager is pnpm 11.15.1 via Corepack.

Run installs at the repository root. Use Turbo filters rather than nested package installs.

The credential-free provider simulator is implemented inside
`@velum-labs/routekit-testkit`; no external executable, Python environment, or
sibling checkout is required. `pnpm test:e2e:matrix` builds and starts it on an
ephemeral loopback port.

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

If an E2E matrix case skips, inspect the report's reason code. Simulator-backed
HTTP cases must not skip; only absent optional coding-agent CLIs and explicitly
unauthorized live-account cases are environment-gated.
