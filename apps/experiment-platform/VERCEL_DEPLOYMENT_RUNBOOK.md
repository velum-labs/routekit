# Vercel deployment runbook

This runbook provisions the development experiment project. Do not connect locked-test data to
this project.

## 1. Authenticate and link

```bash
corepack pnpm dlx vercel@latest login
corepack pnpm dlx vercel@latest link \
  --cwd . \
  --scope YOUR_TEAM \
  --project routekit-experiments-development \
  --yes
```

If the project does not exist, create it first:

```bash
corepack pnpm dlx vercel@latest projects add routekit-experiments-development
```

Configure the monorepo root before deploying:

```bash
corepack pnpm dlx vercel@latest project update routekit-experiments-development \
  --root-directory apps/experiment-platform \
  --framework nextjs \
  --install-command 'corepack pnpm install --frozen-lockfile' \
  --build-command 'corepack pnpm exec turbo run build --filter=@velum-labs/routekit-experiment-platform...'
```

## 2. Create storage

Create a private Blob store:

```bash
corepack pnpm dlx vercel@latest blob create-store routekit-experiments-development
```

Install Neon from the Vercel Marketplace and connect it to the project. The exact Marketplace
product slug can be found with:

```bash
corepack pnpm dlx vercel@latest integration discover neon
```

Use a separate Neon database and Blob store for a future locked-evaluator project.

## 3. Configure secrets

Generate independent random values for the API token, dashboard username, and dashboard password.
Add each value to production, preview, and development:

```bash
corepack pnpm dlx vercel@latest env add EXPERIMENT_PLATFORM_API_TOKEN production,preview,development
corepack pnpm dlx vercel@latest env add EXPERIMENT_PLATFORM_DASHBOARD_USER production,preview,development
corepack pnpm dlx vercel@latest env add EXPERIMENT_PLATFORM_DASHBOARD_PASSWORD production,preview,development
corepack pnpm dlx vercel@latest env add EXPERIMENT_PLATFORM_PROJECT_ROLE production,preview,development
corepack pnpm dlx vercel@latest env add EXPERIMENT_PLATFORM_ALLOW_LOCKED_TEST production,preview,development
corepack pnpm dlx vercel@latest env add EXPERIMENT_PLATFORM_MAX_UPLOAD_BYTES production,preview,development
```

For the development project:

```text
EXPERIMENT_PLATFORM_PROJECT_ROLE=development
EXPERIMENT_PLATFORM_ALLOW_LOCKED_TEST=0
EXPERIMENT_PLATFORM_MAX_UPLOAD_BYTES=5368709120
```

For hosted-model jobs, configure either:

- `ROUTEKIT_GATEWAY_URL` and a dedicated `ROUTEKIT_EVAL_TOKEN`; or
- `AI_GATEWAY_URL=https://ai-gateway.vercel.sh`, using automatic Vercel OIDC authentication.

Never reuse an ordinary online-routing token.

## 4. Build the immutable runner

The immutable coding-router image is built by
`.github/workflows/build-experiment-runner.yml`. Configure the repository secret
`EXPERIMENT_VERCEL_TOKEN`, then dispatch the workflow after its workflow file is available on
the default branch:

```bash
gh workflow run build-experiment-runner.yml --ref BRANCH_OR_COMMIT
```

During initial branch setup, its branch-limited `push` trigger can build before the workflow
exists on the default branch. Record the returned `@sha256:` digest in experiment manifests.
Never use a mutable tag.

## 5. Freeze and upload datasets and repositories

Generate exact public-PR development/confirmation partitions and content-addressed repository
snapshot stores:

```bash
corepack pnpm --filter @velum-labs/routekit-experiment-platform assets:freeze
corepack pnpm --filter @velum-labs/routekit-experiment-platform inputs:prepare
```

Upload the four large archives with `assets:upload` in an environment that provides
`BLOB_READ_WRITE_TOKEN`. Upload the 48 small task inputs through the authenticated platform API:

```bash
corepack pnpm --filter @velum-labs/routekit-experiment-platform assets:upload
corepack pnpm --filter @velum-labs/routekit-experiment-platform inputs:upload
```

Do not upload locked-test data. Verify exact paths against
`FROZEN_ASSET_INVENTORY_2026-08-17.md`.

## 6. Validate cloud dependencies

Pull the development environment and run the non-secret readiness check:

```bash
corepack pnpm dlx vercel@latest env pull .env.local --cwd .
corepack pnpm experiments:cloud:check
```

The check verifies Node, authentication settings, project role, Postgres, Blob, and optionally the
hosted-model gateway. It prints no credential values.

## 7. Deploy

```bash
corepack pnpm dlx vercel@latest deploy \
  --cwd . \
  --prod
```

Vercel Workflow generates its well-known handlers during the build. `vercel.json` registers the
hosted-model and Sandbox Queue consumers.

## 8. Prepare manifests without submitting

After the runner digest is known, generate validated development and confirmation manifests:

```bash
corepack pnpm --filter @velum-labs/routekit-experiment-platform manifests:generate -- \
  --image 'routekit-experiment-runner@sha256:IMAGE_DIGEST' \
  --source-commit SOURCE_COMMIT
```

This only creates manifest files. It does not submit or approve experiments.

## 9. Pilot sequence

1. Run a zero-cost local-command pilot locally.
2. Run the same deterministic fixture in a Vercel Sandbox.
3. Compare output, metrics, manifest, dataset, and configuration hashes.
4. Interrupt one Sandbox run and verify resume without duplicate completion.
5. Verify stale workers cannot complete a reclaimed or cancelled job.
6. Submit the same final approval twice and verify only one Workflow run is recorded.
7. Interrupt one hosted-model worker after paid-call dispatch and verify the expired lease becomes
   a terminal failure without a second provider call.
8. Verify paid confirmation and paid locked-test manifests remain blocked until both approvals are
   recorded.
9. Verify cancellation closes running attempt rows and both budget limits, including a run whose
   actual cost exceeds its
   estimate.
10. Run one small paid hosted-model canary.
11. Only then increase hosted concurrency toward 16.

Do not use the Benjamin locked test during infrastructure validation.

The August 17, 2026 production pilot and immutable evidence hashes are recorded in
`VERCEL_PILOT_RESULTS_2026-08-17.md`.
