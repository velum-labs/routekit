# RouteKit experiment platform

This app implements the first usable vertical slice of the approved Vercel experiment
platform.

It provides:

- a Next.js dashboard and API for submission, status, approval, and cancellation;
- immutable manifests, deterministic hashes, and paired task × treatment × seed jobs;
- provider and infrastructure budget reservation before work starts;
- a local JSON ledger and a normalized Neon/Postgres production ledger;
- local and Vercel Blob content-addressed artifact stores;
- Vercel Workflow coordination and Vercel Queue consumers;
- hosted-model execution through a pinned OpenAI-compatible RouteKit endpoint;
- Vercel Sandbox execution from digest-pinned VCR images;
- automatic Markdown reports and machine-readable classification metrics;
- single-label and multi-area metrics, including scope/area Brier scores, all-gold
  hit@3, and exact-set accuracy at probability 0.5;
- idempotent claims, leases, retries, cancellation, and resume behavior;
- one durable Workflow start per experiment, even when approval requests are repeated;
- fail-closed paid-call handling that prevents an ambiguous provider request from being
  dispatched twice.

The development control plane is deployed to the Velum Labs Vercel team as
`routekit-experiments-development`. It uses a private Blob store, a dedicated Neon database,
Vercel Workflow, Queue consumers, Vercel Sandbox, Vercel Container Registry, and Vercel AI
Gateway. The development role rejects locked-test data.

The first production Sandbox pilot completed on August 17, 2026. It verified the Workflow,
Queue, Sandbox, Blob, Neon, approval, budget, metrics, and reporting path. See
`VERCEL_PILOT_RESULTS_2026-08-17.md`.

## Local start

From the repository root:

```bash
corepack pnpm install
cp apps/experiment-platform/.env.example apps/experiment-platform/.env.local
corepack pnpm experiments:dev
```

Open `http://localhost:3010`.

Without `DATABASE_URL` and Blob credentials, the app writes under
`.routekit-experiments/`. Without Vercel Queue credentials, Workflow executes queued jobs
inline. These fallbacks allow the contracts and resume logic to be verified before cloud access
is granted. On Vercel, database and Blob credentials are mandatory; the app will not silently
fall back to ephemeral files.

## CLI

The repository includes a small CLI that uses the same authenticated API as the dashboard:

```bash
export EXPERIMENT_PLATFORM_URL=http://127.0.0.1:3010
export EXPERIMENT_PLATFORM_API_TOKEN=... # omit only for local unprotected development

corepack pnpm experiments:cli upload task.json inputs
corepack pnpm experiments:cli submit experiment.yaml
corepack pnpm experiments:cli status EXPERIMENT_ID
corepack pnpm experiments:cli approve EXPERIMENT_ID paid_execution
corepack pnpm experiments:cli report EXPERIMENT_ID report.md
corepack pnpm experiments:cli metrics EXPERIMENT_ID metrics.json
corepack pnpm experiments:cli cancel EXPERIMENT_ID
```

The token is read from the environment instead of a command-line argument so it is not written to
shell history.

Approval requirements compose instead of replacing one another. A paid confirmation run requires
both `paid_execution` and `confirmation`; a paid locked-test run requires both `paid_execution` and
`locked_test`. Queue consumers cannot claim pending work until every required approval is recorded.

Immediately before a hosted-model request, the worker durably disables automatic retry for that
job and sends its deterministic job key as `Idempotency-Key`. If the worker dies, times out, or
loses its lease after this point, the job fails for manual review instead of issuing another paid
request. The ledger conservatively charges the frozen estimate when the exact provider result is
unknown. Explicit provider timeouts are capped at 240 seconds so a 300-second Queue function still
has time to record the result.

## Local pilot

Upload a real content-addressed input artifact:

```bash
curl -X POST http://localhost:3010/api/artifacts \
  -H 'content-type: application/json' \
  -H 'x-artifact-kind: inputs' \
  --data '{"prompt":"classify this task"}'
```

Copy the returned `artifact.pathname` into `examples/local-pilot.yaml`, then submit:

```bash
curl -X POST http://localhost:3010/api/experiments \
  -H 'content-type: text/yaml' \
  --data-binary @apps/experiment-platform/examples/local-pilot.yaml
```

The included runner is an infrastructure health check, not an accuracy result.

The server upload route is intended for small task records. Large frozen datasets, repository
snapshots, indexes, and embedding files should use the Vercel Blob client-upload route at
`/api/artifacts/client-upload`; callers compute the SHA-256 path before requesting a multipart
upload token. Client uploads default to a 5 GiB per-object limit, configurable through
`EXPERIMENT_PLATFORM_MAX_UPLOAD_BYTES` up to 50 GiB.

## Vercel setup

The development deployment uses this setup:

1. Link the repository root to the Vercel project and configure its Root Directory as
   `apps/experiment-platform`.
2. Create a private Vercel Blob store.
3. Add a Neon database through the Vercel Marketplace.
4. Set `EXPERIMENT_PLATFORM_API_TOKEN`.
5. Enable Vercel Deployment Protection and set the dashboard Basic Auth variables as a second
   layer.
6. Configure either:
   - `ROUTEKIT_GATEWAY_URL` plus a dedicated `ROUTEKIT_EVAL_TOKEN`; or
   - `AI_GATEWAY_URL=https://ai-gateway.vercel.sh` and Vercel OIDC authentication.
7. Pull the development environment from the linked repository root with `vercel env pull`.
8. Deploy. The Workflow plugin creates its well-known routes and `vercel.json` registers Queue
   consumers.
9. Run a zero-cost pilot before enabling paid calls.

Generated local credentials are stored outside the repository at
`~/.config/routekit/experiment-platform-development.env` with mode `0600`.

The app applies `sql/001_experiment_platform.sql` idempotently when it first connects. The SQL
file can also be reviewed and applied directly.

## Runner image

The production coding-router runner is built in GitHub Actions because the development VM does
not require a local container engine:

```bash
gh workflow run build-experiment-runner.yml \
  --ref feat/vercel-experiment-platform
```

The workflow uses the dedicated `EXPERIMENT_VERCEL_TOKEN` GitHub secret, builds
`Dockerfile.coding-router-runner`, pushes to `routekit-experiment-runner`, and reports the
immutable digest. The image contains the frozen classifier/retrieval implementation and tools,
but no datasets or credentials.

## Frozen coding-router assets

The development and confirmation datasets, exact Kubernetes/Grafana Git snapshots, and 48
treatment-specific task inputs are uploaded to private Blob storage. See
`FROZEN_ASSET_INVENTORY_2026-08-17.md` for exact hashes and paths.

To reproduce the local, ignored assets:

```bash
corepack pnpm --filter @velum-labs/routekit-experiment-platform assets:freeze
corepack pnpm --filter @velum-labs/routekit-experiment-platform inputs:prepare
```

Task inputs contain task-aware context, enriched Area Cards, fixed hybrid-rerank evidence, and
strict response schemas for `direct`, `evidence_first`, and `independent_per_area`. Labels are
kept out of model requests and are used only as task metadata during reduction.

## Job contract

Command workers receive:

- input bytes on standard input for local execution;
- `ROUTEKIT_EXPERIMENT_*` environment variables;
- in Sandbox, the input path in `ROUTEKIT_EXPERIMENT_INPUT`;
- in Sandbox, the result path in `ROUTEKIT_EXPERIMENT_OUTPUT`.

Workers should write one JSON result. Hosted-model inputs may contain `{"prompt":"..."}` or an
OpenAI-compatible `messages` array. Treatments must set an explicit `configuration.model`;
`auto`, `router`, and unqualified IDs are rejected.

Classification workers may return the standardized prediction directly, under `prediction` or
`result`, or as JSON in the hosted model's response content. The platform adds measured latency,
cost, and frozen provenance before storing the output. A classification prediction contains:

- `scopeProbabilities`;
- `areaProbabilities`;
- `rankedAreas`.

Tasks provide labels through `metadata.expectedScope`, legacy `metadata.expectedArea`, and/or
multi-area `metadata.expectedAreas`. After all jobs finish, the reducer writes immutable JSON
metrics and adds scope hit@1, scope Brier, area hit@1, all-gold hit@3, exact-set accuracy at
probability 0.5, area Brier, Wilson 95% confidence intervals, median latency, and cost to the
Markdown report. Both artifacts can be opened from the experiment dashboard.

## Locked-test separation

Do not place locked labels in this development project. Before a locked test:

- deploy a second Vercel project with separate Blob, Postgres, and credentials;
- expose only a narrow frozen-prediction evaluation endpoint;
- explicitly approve the one-time locked test;
- verify the development project cannot read locked labels.

The implementation models locked-test approval but intentionally does not include or run the
Benjamin locked dataset.

Locked-test manifests are rejected unless the deployment is explicitly configured as a separate
`locked-evaluator` project and locked execution is enabled. The development project must keep the
default disabled settings.

## Composition-classifier experiment

The prepared Luna-versus-Sol continuous area-composition experiment is documented in
`COMPOSITION_EXPERIMENT_RUNBOOK_2026-08-18.md`. Its preparation, upload, and manifest-generation
commands are:

```bash
pnpm --filter @velum-labs/routekit-experiment-platform composition:prepare
pnpm --filter @velum-labs/routekit-experiment-platform composition:upload
pnpm --filter @velum-labs/routekit-experiment-platform composition:manifests -- \
  --image '<immutable-runner-image>' \
  --source-commit '<implementation-commit>'
```

These commands prepare infrastructure and artifacts only. Paid inference still requires
manifest submission followed by explicit `paid_execution` approval.

## Area-taxonomy and onboarding experiments

The proposed experiments for choosing repository-specific areas, Area Card requirements,
granularity, overlap constraints, unknown coverage, routing-aware merge/split rules, and the
eventual onboarding workflow are specified in
`AREA_TAXONOMY_EXPERIMENT_SPEC_2026-08-18.md`.

That document is a research specification only. It does not authorize artifact upload, manifest
submission, paid inference, confirmation execution, or a budget change.
