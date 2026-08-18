# Live billed eval-routing qualification

This lane qualifies RouteKit's sole automatic-routing architecture:

1. Luna classifies request text against the reviewed eight-dimension routing
   basis and returns a complete normalized request decomposition plus
   `unknownWeight`.
2. Terra authors five grounded cases for each workload dimension from bounded
   files in a clean detached worktree.
3. Luna, Terra, and Sol each run all five cases for every workload dimension,
   and Terra judges every candidate case.
4. RouteKit rejects incomplete comparison evidence, compiles the complete
   3-model × 8-dimension evidence matrix, and publishes one routing snapshot.
5. Deterministic code combines each live classification vector, the published
   evidence matrix, request requirements, and the configured objective.
6. Eight single-dimension and four composition `model: auto` probes each make
   exactly one Luna classifier call and one selected inference call.

The full nominal run is 298 billed calls:

- 26 Luna classifier-qualification calls;
- 8 Terra suite-author calls;
- 240 comparison calls: 8 dimensions × (15 candidate + 15 judge);
- 24 probe calls: 12 classifier + 12 inference.

Author retries can increase the actual count, so the call failsafe remains
higher than the nominal plan.

The lane uses no provider simulator, provider mock, fake Effect layer, canned
model response, planted snapshot, or globally installed RouteKit binary.

## Authorization

Live execution is manual and disabled by default:

```bash
ROUTEKIT_LIVE_E2E=1 pnpm test:e2e:eval-routing:live -- \
  --live \
  --orbit-url https://orbit-gateway.velum.sh \
  --orbit-token-file /private/path/orbit-e2e-token
```

The token file must be a non-symlink regular file with mode `0600`. The token is
not placed in child arguments, child environments, logs, reports, or generated
eval artifacts.

Orbit must advertise:

- candidates: `openai/gpt-5.6-luna`, `openai/gpt-5.6-terra`,
  `openai/gpt-5.6-sol`;
- classifier: `openai/gpt-5.6-luna`;
- author and judge: `openai/gpt-5.6-terra`.

To run only the 26-case classifier qualification:

```bash
ROUTEKIT_LIVE_E2E=1 pnpm test:e2e:eval-routing:live -- \
  --live \
  --classifier-only \
  --orbit-url https://orbit-gateway.velum.sh \
  --orbit-token-file /private/path/orbit-e2e-token
```

Classifier-only success does not qualify model selection or publication.

## Failsafes and unpriced calls

Defaults:

- 512 billed egress calls;
- 5,000,000 input tokens;
- 1,000,000 output tokens;
- 16,384 output tokens per call;
- two hours wall time;
- $100 known-price subtotal.

GPT-5.6 pricing is not currently available. RouteKit never invents pricing and
never represents unknown cost as zero. `estimatedCostUsd` is only the
known-priced subtotal. If any call is unpriced:

- `unpricedCalls` is nonzero;
- the CLI prints `estimated_usd=unknown`;
- `dollarFailsafeStatus` is `unavailable-for-unpriced-calls`.

The call, input-token, output-token, per-call output, and wall-time failsafes
remain active.

The egress guard reserves capacity before each generation, requires complete
usage accounting afterward, never follows redirects, and blocks further billed
work if a reservation cannot be reconciled safely.

## Isolation, cleanup, and evidence

Every run uses a clean detached worktree, isolated RouteKit home, loopback
egress guard, and embedded router. Effect scopes close the router, guard,
processes, and temporary resources before the final report is generated.

Sanitized evidence is written beneath:

```text
.artifacts/eval-routing/<run-id>/
  events.jsonl
  report.json
  classifier-qualification-v2.json
  published-routing.json
  dimensions/
    <dimension-id>/
      dimension.yaml
      comparison.json
      eval/
        <dimension-id>.eval.ts
        routekit.eval-manifest.json
        data/cases.json
```

The retained eval directory is the exact authored suite used for comparison.
`comparison.json` contains sanitized per-model, per-case outcomes and
measurements. Apart from the reviewed case material intentionally retained in
the exact authored suite, artifacts do not retain credentials, headers,
provider request bodies, provider responses, free-form child output, or
absolute temporary paths.

The first complete passing run, including its exact generated eval suites and
sanitized results, is committed for review at:

```text
docs/evidence/eval-routing/2026-08-17-562483cd6669/
```

## Passing contract

A passing full report proves:

- all 26 reviewed classifier cases met the qualification thresholds;
- exactly eight workload dimensions were authored with five cases each;
- every dimension contains complete Luna/Terra/Sol candidate rows and Terra
  judge scores for every expected case;
- the complete 24-cell model-by-dimension evidence matrix was published;
- single-dimension probes classify primarily into their expected dimension;
- composition probes assign material weight to at least two dimensions;
- each probe records one Luna classifier call and one selected inference call;
- provenance retains requested model `auto`, the request decomposition, unknown
  weight, evidence digest, objective, candidates, and effective model;
- the final ledger has zero active reservations and zero unknown measurements;
- unpriced calls are explicit; and
- `report.json` is written after cleanup with a consistent `eventCount` and
  status `passed`.

Five authored cases per dimension are sufficient for this billed testdrive, not
for production approval. Production activation still requires at least 20
reviewed model-eval cases per dimension and a complete evidence matrix derived
from those reviewed cases.
