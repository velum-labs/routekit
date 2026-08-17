# Live billed eval-routing qualification

This lane qualifies RouteKit's sole automatic-routing architecture:

1. Luna classifies request text against the reviewed eight-area catalog and
   returns a complete normalized area vector plus `unknownWeight`.
2. Terra authors five grounded cases for each area from bounded files in a
   clean detached worktree.
3. Luna, Terra, and Sol each run all five cases for every area, and Terra judges
   every candidate case.
4. RouteKit rejects incomplete comparison evidence, compiles the complete
   3-model × 8-area matrix, and publishes one routing snapshot.
5. Deterministic code combines each live classification vector, the published
   evidence matrix, request requirements, and the configured objective.
6. Eight single-area and four composite `model: auto` probes each make exactly
   one Luna classifier call and one selected inference call.

The full nominal run is 298 billed calls:

- 26 Luna classifier-qualification calls;
- 8 Terra suite-author calls;
- 240 comparison calls: 8 areas × (15 candidate + 15 judge);
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
  published-routing.v2.json
  areas/
    <area-id>/
      routing-profile.yaml
      comparison.json
      eval/
        <area-id>.eval.ts
        routekit.eval-manifest.json
        data/cases.json
```

The retained eval directory is the exact authored suite used for comparison.
`comparison.json` contains sanitized per-model, per-case outcomes and
measurements. Artifacts do not retain credentials, headers, prompts sent to
providers, provider responses, free-form child output, or absolute temporary
paths.

## Passing contract

A passing full report proves:

- all 26 reviewed classifier cases met the qualification thresholds;
- exactly eight areas were authored with five cases each;
- every area contains complete Luna/Terra/Sol candidate rows and Terra judge
  scores for every expected case;
- the complete 24-cell model-by-area evidence matrix was published;
- single-area probes classify primarily into their expected area;
- composite probes assign material weight to at least two areas;
- each probe records one Luna classifier call and one selected inference call;
- provenance retains requested model `auto`, the area vector, unknown weight,
  evidence digest, objective, candidates, and effective model;
- the final ledger has zero active reservations and zero unknown measurements;
- unpriced calls are explicit; and
- `report.json` is written after cleanup with a consistent `eventCount` and
  status `passed`.

Five authored cases per area are sufficient for this billed testdrive, not for
production approval. Production activation still requires at least 20 reviewed
model-eval cases per area and a complete evidence matrix derived from those
reviewed cases.
