# @velum-labs/routekit-eval-contracts

Versioned evaluation run, result, evidence, and policy contracts encoded as
Effect Schema. Candidate and judge calls always name explicit model IDs;
evaluation never uses the auto-router.

## Compositional routing v2

Version 2 keeps request understanding separate from model selection:

1. A reviewed catalog defines five to ten semantic routing areas.
2. The classifier returns one weight for every area plus `unknownWeight`.
3. A published snapshot supplies a complete candidate-model by area evidence
   matrix.
4. A deterministic objective ranks eligible models from that vector and
   evidence.

The classifier contracts contain no model IDs, prices, evidence, winners, or
fallbacks. Use the exported assertion functions after schema decoding to
enforce relationships that span multiple fields or documents:

- `assertRoutingAreaCatalog`
- `assertAreaClassificationInput`
- `assertAreaClassificationResult`
- `assertRequestAreaDecomposition`
- `assertRoutingObjectivePolicy`
- `assertPublishedRoutingSnapshotV2`
- `assertAutoRoutingDecisionV2`

These checks reject incomplete or duplicate vectors and evidence cells,
definition/evidence digest mismatches, invalid model IDs, non-normalized
objectives, and misleading cost averages when any calls are unpriced.
