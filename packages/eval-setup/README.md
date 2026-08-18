# @velum-labs/routekit-eval-setup

Effect-native, interruption-safe onboarding primitives for compositional
RouteKit eval routing.

The package provides:

- a durable one-question-at-a-time eval-project state machine;
- bounded repository inspection and an authoritative source inventory;
- atomic project artifacts beneath `.routekit/evals`;
- reviewed routing-basis and workload-dimension workflows;
- digest-bound approvals for dimensions and dimension suites;
- explicit candidate, classifier, author, and judge model roles;
- immutable validation, estimate, qualification, result, and activation stages;
- typed Effect service contracts for repository, planning, target, run, and
  activation adapters; and
- the `setup-eval-routing` coding-agent skill.

The decomposition classifier is deliberately model-blind: it receives only the
request and reviewed workload dimensions. Deterministic routing combines its
normalized request decomposition with hard requirements, the configured
objective and constraints, and the published model-by-dimension evidence
matrix.
