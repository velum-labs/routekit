# RouteKit area-taxonomy and onboarding experiment specification

Status: specification only; not authorized for submission or paid execution

- Date: 2026-08-18
- Scope: repository-specific area design for the Luna direct classifier
- Execution environment: RouteKit Vercel experiment platform
- Runtime classifier: GPT-5.6 Luna direct area-composition classification
- Offline reference: GPT-5.6 Sol

## 1. Executive summary

RouteKit has selected direct Luna classification as the initial runtime area classifier. The
classifier receives task-aware context, a repository profile, repository evidence, and a frozen
Area Registry. It returns:

```json
{
  "area_composition_scores": {
    "backend": 0.9,
    "authentication": 0.75,
    "frontend": 0.05
  },
  "unknown_probability": 0.12
}
```

Known-area scores are independent estimates of implementation responsibility. They do not need
to sum to one. `unknown_probability` is separate and must not reduce or renormalize the
known-area scores.

This research program asks how onboarding should define the areas that appear in that contract.
It is not enough to choose the taxonomy with the lowest classifier error. A single area called
`all engineering` would be easy to classify and useless for routing. The selected onboarding
method must produce areas that are:

1. semantically identifiable by Luna;
2. sufficiently complete to support unknown detection;
3. non-redundant under the additive routing assumption;
4. stable on future tasks;
5. detailed enough to preserve routing-relevant model-performance differences; and
6. practical to generate and review during one-time onboarding.

The experiments therefore evaluate two objectives separately:

- **classification quality:** can Luna reproduce a strong Sol reference for this Area Registry?
- **taxonomy utility:** does this Area Registry preserve meaningful and routing-relevant
  distinctions without unnecessary duplication?

No single scalar score may hide a poor result on either objective. Selection uses a Pareto
comparison and explicit validity gates.

## 2. Product contract and interpretation

### 2.1 Areas are routing dimensions

An area is a repository-specific implementation responsibility that may affect model fitness.
It is not necessarily:

- a directory;
- a programming language;
- a team;
- a single package;
- a user-visible feature; or
- a mutually exclusive class.

Several areas may be materially active for the same task. For example, a request may require
both backend endpoint work and authentication-policy work.

### 2.2 Good and bad overlap

The experiments distinguish two meanings of overlap:

- **task overlap:** one task legitimately contains separate responsibilities owned by several
  areas. This is expected and desirable.
- **semantic overlap:** the same atomic responsibility activates multiple areas for essentially
  the same reason. Under an additive router this can duplicate evidence and double-count work.

Path overlap is not equivalent to semantic overlap. Authentication, observability, and platform
work may share files with feature areas while remaining distinct responsibilities.

### 2.3 Flat runtime vector

The first product version uses one flat vector. Parent and child concepts such as `frontend` and
`React components` should not both appear at the same runtime level unless an experiment shows
that the relationship is identifiable, non-redundant, and useful. Hierarchical metadata may be
stored during onboarding, but only one chosen cut of the hierarchy is presented to Luna.

### 2.4 Unknown remains separate

The taxonomy must not add a vague `other`, `miscellaneous`, or `everything else` area merely to
increase apparent coverage. Uncovered material work belongs in `unknown_probability`. A
specific shared-infrastructure area is allowed only when it has a positive, testable ownership
definition.

## 3. Research questions

The research program must answer:

1. Which basis produces the most identifiable areas: repository structure, ownership,
   implementation responsibility, or a hybrid?
2. How many areas can Luna distinguish before additional granularity hurts more than it helps?
3. How much semantic overlap is tolerable?
4. Which Area Card fields are required?
5. How complete should a registry be, and when is a shared area valid?
6. Should areas with nearly identical model-performance profiles be merged?
7. When should an area be split because its subareas have different model-performance profiles?
8. Do the conclusions survive new tasks, paraphrases, contextual prompts, and repository drift?
9. What repository and historical data should onboarding collect?
10. How much engineer review is required after automatic area generation?

## 4. Hypotheses

The following hypotheses are registered before execution:

1. Responsibility-first areas anchored to repository paths and symbols will outperform
   path-only or team-only areas.
2. Classification quality will follow an inverted-U curve with granularity: coarse registries
   lose routing information, while very fine registries produce boundary confusion.
3. Controlled task overlap will be harmless, but semantic redundancy and parent-child mixing
   will reduce reference agreement and Luna stability.
4. Negative boundaries and confusable-neighbor rules will add more value than additional raw
   path anchors once a basic description is present.
5. A vague catch-all area will make unknown detection look easier while reducing the meaning of
   `unknown_probability`.
6. Routing-aware merging will be useful; model-performance-only area generation will be less
   semantically identifiable than responsibility-first generation.
7. Historical task examples will materially improve automatic onboarding over repository-tree
   inspection alone.

These are hypotheses, not assumptions that may be written into the final report as results.

## 5. Fixed decisions

The following are fixed across Experiments 1–7 unless the experiment explicitly names the
variable:

1. Runtime classifier is direct GPT-5.6 Luna classification.
2. Runtime representation is task-aware context. Latest-request-only is forbidden.
3. The output is the independent composition-score contract shown above.
4. `unknown_probability` is predicted separately.
5. The classifier receives no model-performance evidence.
6. The classifier receives no repository tools during this experiment series.
7. Repository evidence is frozen before creating candidate taxonomies and remains identical
   across taxonomy treatments for the same task.
8. Retrieval configuration, evidence order, and evidence token budget remain fixed.
9. Luna prompt, reasoning effort, response schema, and completion budget remain fixed after the
   composition-prompt experiment selects a production candidate.
10. If that earlier experiment has not selected a prompt, the provisional fixed candidate is
    the anchored direct classifier with internal responsibility decomposition.
11. Sol is an offline silver reference, not ground truth.
12. Real tasks determine primary conclusions. Synthetic tasks are reported as stress tests.
13. No locked-test data may enter the development Vercel project.
14. Every paid phase requires a canary, a frozen cost estimate, manifest submission, and
    explicit approval.
15. This specification does not authorize any call, submission, approval, or experiment run.

## 6. Non-goals

This research program does not decide:

- whether model performance is truly additive;
- whether the routing policy selects the globally best model;
- whether softmax or another normalization preserves the correct mixture;
- the final unknown-routing threshold;
- latency optimization;
- tool-using Luna classification;
- online learning;
- model evaluation methodology itself; or
- the production UI for onboarding.

Experiment 6 uses a frozen additive-policy simulation only to measure whether an area distinction
could matter. It does not validate the routing policy.

## 7. Terminology

### Area Registry

The complete versioned list of runtime areas for one repository and one chosen taxonomy.

### Area Card

The structured description of one area, including its positive scope, negative boundaries,
anchors, examples, neighbors, and multi-area rules.

### Responsibility atom

A taxonomy-neutral, concrete implementation responsibility required by a task. A responsibility
atom should be narrow enough that it does not join two separable responsibilities with “and.”

### Taxonomy basis

The principle used to group repository work into areas, such as code topology, team ownership,
implementation responsibility, or a hybrid.

### Semantic overlap

The degree to which one responsibility atom maps materially to more than one area for the same
ownership reason.

### Task co-activation

The frequency with which different responsibility atoms cause two areas to be active in the
same task. Co-activation is not itself a defect.

### Coverage

The weighted fraction of task responsibilities that the registry can represent.

### Support

The number or weighted fraction of real tasks for which an area has a Sol reference score of at
least `0.25`.

### Routing equivalence

Two areas are routing-equivalent when the eligible models have sufficiently similar performance
profiles that distinguishing the areas rarely changes the preferred route under the frozen
additive simulation.

### Diagnostic control

An intentionally weak or invalid taxonomy used to verify that the metrics detect obvious
failure. A diagnostic control is never eligible for promotion.

## 8. Shared study protocol

### 8.1 Experimental unit

The primary experimental unit is:

```text
repository × task × Area Registry × model configuration × seed
```

Every eligible taxonomy comparison is paired: the same task, context, evidence, classifier
configuration, and seed are used. Only the Area Registry and the Area Card material explicitly
under study may change.

### 8.2 Current development data

The existing frozen development dataset is:

```text
composition-development-100-v1
```

It contains:

| Repository | Real tasks | Synthetic composites | Total |
| --- | ---: | ---: | ---: |
| `backstage/backstage` | 34 | 26 | 60 |
| `kubernetes/kubernetes` | 17 | 13 | 30 |
| `grafana/grafana` | 7 | 3 | 10 |
| **Total** | **58** | **42** | **100** |

Interpretation rules:

- Backstage is the primary development repository.
- Kubernetes is a secondary development repository and already has a separate 24-task
  confirmation partition available for re-rendering.
- Grafana is a portability smoke test only. Seven real tasks are insufficient for a
  repository-level product conclusion.
- Synthetic composites are never pooled silently with real tasks.
- Repository-pooled numbers must be accompanied by per-repository numbers.

Before a final cross-repository guideline is approved, collect enough additional real tasks to
reach at least 25 real development or confirmation tasks in every repository used for a product
claim. This requires more Grafana data and a non-development Backstage confirmation set.

### 8.3 Data roles

Use four distinct roles:

1. **construction:** repository data and historical tasks used to propose areas and examples;
2. **development:** tasks used to compare and refine candidate rules;
3. **confirmation:** chronologically later tasks used once after development decisions freeze;
4. **locked test:** optional future data in a separate isolated Vercel project.

No validation, confirmation, or locked task may appear as an Area Card example or directly shape
an area boundary.

### 8.4 Lineage and chronology

- Synthetic composites inherit the lineage of both source tasks.
- A source task and a synthetic composite containing it may not cross data roles.
- Near duplicates and follow-ups from one issue, PR, or session remain in one role.
- Candidate registries record the latest source timestamp used during construction.
- Confirmation tasks must occur after that timestamp when timestamps are available.

### 8.5 Leakage audit

The existing 100-task inputs embed the current Area Registry in two places:

1. the explicit `[FROZEN AREA REGISTRY]`; and
2. component names in the current repository profile.

New inputs must therefore be regenerated. Merely replacing the registry JSON is invalid.

For taxonomy experiments:

- the repository profile must be taxonomy-neutral and identical across candidate registries;
- it may contain factual languages, frameworks, architecture, and repository purpose;
- it must not repeat candidate area names or descriptions;
- repository evidence must not use known changed files, completed diffs, PR labels as labels, or
  the candidate Area Registry as a retrieval query;
- response schemas must require exactly the area IDs for the current registry; and
- reference labels and responsibility atoms must never appear in Luna requests.

### 8.6 Fixed task package

Each Luna request contains, in this order:

1. fixed direct-classifier system instruction;
2. candidate Area Registry;
3. taxonomy-neutral repository profile;
4. task-aware conversation;
5. task-specific repository evidence in a separately marked section; and
6. a strict JSON Schema for the candidate area IDs.

The same task package hash, excluding the registry and response schema, must be recorded across
all candidate taxonomies.

### 8.7 Repository snapshots

Exact Kubernetes and Grafana snapshot stores are already frozen. A tool-using Sol construction
or onboarding-generation pass for Backstage additionally requires a content-addressed Backstage
snapshot store. Until that exists, Backstage Sol calls may use only the already frozen task
evidence and must be marked `evidence_only`.

No experiment may silently mix full-repository Sol references with evidence-only references in
one aggregate without stratifying the report.

### 8.8 Classifier configuration

The frozen Luna configuration must include:

- exact model ID;
- exact prompt version;
- reasoning effort;
- maximum completion tokens;
- strict response schema;
- provider and provider-routing settings;
- task package hash;
- registry hash;
- seed;
- timestamp;
- latency;
- input and output usage; and
- provider cost.

No automatic model substitution is permitted.

For one-sample screening, use experiment seed `181081`. For three-sample stability checks, use
`181081`, `181082`, and `181083`. A matrix seed is always recorded as provenance. It is passed to
the provider only when the selected endpoint documents seed support. Otherwise, the repetitions
are independent calls and the report must not describe the seed as controlling provider
determinism.

### 8.9 Sol reference configuration

Sol receives:

- the complete visible task-aware episode;
- frozen repository evidence;
- the exact candidate Area Registry when producing registry-specific scores;
- neutral responsibility atoms from Experiment 0;
- read-only repository tools only when the corresponding snapshot is available; and
- no model-performance evidence.

Sol returns strict structured output. It may internally decompose responsibilities but may not
expose hidden chain-of-thought. Short factual mapping reasons and evidence references are
allowed.

### 8.10 Reference repetition and adjudication

Run one Sol reference for every scored task and registry. Run a second independent pass when:

- Sol reports less than high confidence;
- `unknown_probability >= 0.3`;
- at least two areas score `>= 0.25`;
- the task is synthetic;
- no repository evidence supports a material responsibility;
- the registry contains a flagged overlap pair; or
- the first pass violates the contract.

If two valid passes disagree materially, run one adjudication call. Material disagreement means
any of:

- cosine similarity below `0.90`;
- an absolute area-score difference above `0.25`;
- an unknown-probability difference above `0.20`; or
- different active-area sets at threshold `0.25`.

Persist every proposal and the adjudication. Exclude unresolved cases from ordinary
Luna-versus-Sol accuracy denominators, but retain them in the taxonomy-ambiguity report.

### 8.11 Canary policy

Every new runner, schema, prompt family, or execution path receives a no-more-than-ten-task
canary before a development run. A canary must verify:

- model IDs and provider attribution;
- strict-contract validity;
- registry-specific response keys;
- artifact writes;
- reducer compatibility;
- no reference leakage into candidate requests;
- actual cost within the frozen reservation; and
- no active or queued job after cancellation or completion.

## 9. Artifact schemas

### 9.1 Neutral responsibility annotation

Experiment 0 produces one immutable annotation per task:

```json
{
  "schema_version": 1,
  "task_id": "task-123",
  "repository_id": "owner/repository",
  "repository_snapshot": "commit-or-synthetic-marker",
  "responsibilities": [
    {
      "responsibility_id": "r1",
      "summary": "Change OAuth PKCE option handling in the authentication client.",
      "materiality": 0.9,
      "affected_components": ["OAuth client", "authentication service"],
      "evidence_refs": ["pkg/services/authn/clients/oauth.go"],
      "confidence": "high"
    }
  ],
  "repository_scope": "coding",
  "insufficient_information_probability": 0.05,
  "reference_mode": "full_repository",
  "provenance": {
    "model": "openai/gpt-5.6-sol",
    "prompt_version": "neutral-responsibility-v1",
    "dataset_hash": "sha256:...",
    "configuration_hash": "sha256:..."
  }
}
```

Rules:

- Candidate area names are forbidden.
- `materiality` uses the same `0.00` to `1.00` responsibility rubric as the classifier.
- A responsibility must describe requested implementation, not a dependency mention.
- Separate responsibilities that belong to different owners or could be implemented
  independently.
- Evidence references must exist in the exact snapshot or the frozen task evidence.

### 9.2 Candidate registry

Every candidate registry must include:

```json
{
  "schema_version": 1,
  "registry_id": "kubernetes-responsibility-k8-v1",
  "repository_id": "kubernetes/kubernetes",
  "repository_snapshot_set": "sha256:...",
  "basis": "responsibility",
  "classification_level": "runtime_leaf",
  "eligible_for_promotion": true,
  "construction_cutoff": "2026-08-01T00:00:00Z",
  "areas": [],
  "relations": [],
  "generation_provenance": {}
}
```

Each area must include:

```json
{
  "area_id": "authentication-security",
  "name": "Authentication and security",
  "activation_rule": "Activate when completing the task materially changes authentication, identity, authorization, session, or security-control behavior.",
  "description": "Repository-specific description.",
  "inclusions": [],
  "exclusions": [],
  "confusable_area_ids": [],
  "path_anchors": [],
  "component_anchors": [],
  "symbol_anchors": [],
  "code_summaries": [],
  "positive_example_ids": [],
  "boundary_examples": [],
  "multi_area_rules": [],
  "parent_area_id": null
}
```

Model names, model rankings, benchmark scores, and routing recommendations are forbidden in the
runtime Area Card. Experiment 6 stores routing evidence in a separate onboarding-only artifact.

### 9.3 Registry-specific Sol mapping

The rich Sol reference artifact contains:

```json
{
  "task_id": "task-123",
  "registry_id": "kubernetes-responsibility-k8-v1",
  "responsibility_mappings": [
    {
      "responsibility_id": "r1",
      "area_strengths": {
        "authentication-security": 1.0
      },
      "unmapped_probability": 0.0,
      "evidence_refs": []
    }
  ],
  "area_composition_scores": {},
  "unknown_probability": 0.0,
  "confidence": "high"
}
```

The standard composition reducer consumes only `area_composition_scores` and
`unknown_probability`; the mapping fields support taxonomy diagnostics.

## 10. Registry validity and diagnostics

### 10.1 Hard structural validity

An eligible registry must:

- contain unique stable area IDs;
- contain at least three and no more than 24 runtime areas for this research program;
- use one declared classification level;
- include an activation rule for every area;
- identify confusable neighbors;
- contain no unknown area reference;
- contain no model-performance information in runtime cards;
- use only construction examples;
- reference paths and symbols that existed at the construction snapshot;
- fit within the frozen Area Registry token budget; and
- pass schema and referential-integrity validation.

### 10.2 Experimental diagnostics, not initial hard gates

The following are measured before being converted into final onboarding constraints:

- weighted pairwise semantic overlap;
- path-anchor overlap;
- minimum real-task support;
- largest-area support share;
- coverage of construction responsibilities;
- effective number of used areas;
- parent-child redundancy;
- reference disagreement;
- classifier stability; and
- routing separability.

Diagnostic controls may intentionally violate these conditions, but must be marked
`eligible_for_promotion: false`.

## 11. Shared metrics

### 11.1 Existing within-registry composition metrics

For Luna paired with Sol under the same registry:

- strict-contract validity;
- cosine similarity;
- mean all-area absolute error;
- active-area and inactive-area absolute error;
- active-area precision, recall, and F1 at `0.25`;
- top-area agreement;
- top-two overlap;
- all Sol-active areas in Luna top three;
- unknown-probability absolute error;
- unknown agreement at `0.3`, `0.5`, and `0.7`;
- latency; and
- provider and infrastructure cost.

### 11.2 Cross-taxonomy comparison warning

Mean all-area absolute error must not be used alone across taxonomies with different area counts.
Adding many inactive areas can reduce the mean without improving the classifier. Coarse
taxonomies can also appear accurate by discarding useful distinctions.

Cross-taxonomy decisions therefore require the metrics below.

### 11.3 Cross-taxonomy classifier metrics

For every task:

- **active reference error:** mean absolute error over Sol-active areas only;
- **false-positive mass:** sum of `max(0, Luna score - Sol score)` over Sol-inactive areas;
- **material-area recall:** fraction of Sol-active areas found by Luna;
- **all-active-at-3:** whether every Sol-active area appears in Luna's top three;
- **unknown MAE and Brier score;**
- **reference stability:** pairwise cosine similarity across repeated Sol references;
- **Luna stability:** pairwise cosine similarity across repeated Luna seeds; and
- **prompt-token cost:** registry and total request token counts.

Report macro averages per repository and per area in addition to task-weighted averages.

### 11.4 Taxonomy utility metrics

Let:

- `w_j` be responsibility atom `j`'s materiality;
- `m_ja` be Sol's mapping strength from atom `j` to area `a`;
- `I(condition)` equal one when the condition is true and zero otherwise; and
- `s_a` be the total real-task active reference mass for area `a`.

Using responsibility mappings:

- **responsibility coverage:**

  ```text
  sum_j w_j × I(max_a m_ja >= 0.5)
  --------------------------------
              sum_j w_j
  ```

- **unmapped responsibility mass:** weighted mass with no mapping strength `>= 0.5`;
- **semantic redundancy incidence:**

  ```text
  sum_j w_j × I(count_a(m_ja >= 0.5) > 1)
  ----------------------------------------
                   sum_j w_j
  ```

- **pairwise semantic overlap:** weighted Jaccard for each area pair:

  ```text
  sum_j w_j × min(m_ja, m_jb)
  ---------------------------
  sum_j w_j × max(m_ja, m_jb)
  ```

- **effective area count:** `exp(-sum_a p_a log p_a)`, where
  `p_a = s_a / sum_b s_b`;
- **largest-area share:** fraction of total active reference mass assigned to the most common
  area;
- **rare-area count:** areas with fewer than five real construction or development examples;
- **neighbor confusion:** error restricted to declared confusable pairs; and
- **reference ambiguity:** fraction of task-registry pairs requiring adjudication or remaining
  unresolved.

Calculate coverage and semantic-overlap diagnostics once on construction responsibilities and
again on development responsibilities. Construction values describe what onboarding knew;
development values reveal generalization. Only construction values may be used to modify the
candidate registry before confirmation.

### 11.5 Routing-usefulness metrics

Experiment 6 additionally reports:

- pairwise distance between area model-performance vectors;
- frequency with which distinguishing two areas changes the top model under the frozen additive
  simulation;
- utility regret from merging areas;
- utility gain from splitting an area;
- variance in atom-level model utility explained by the Area Registry; and
- classification degradation caused by routing-aware definitions.

These metrics are taxonomy diagnostics, not claims that the frozen router is optimal.

### 11.6 Primary evidence hierarchy

Interpret results in this order:

1. real-task per-repository results;
2. real-task pooled paired results;
3. confirmation results;
4. synthetic stress tests;
5. diagnostic controls.

Synthetic improvements may motivate another real-data experiment but cannot establish a product
guideline alone.

### 11.7 Statistical treatment

- Use paired bootstrap intervals over tasks for paired comparisons.
- Resample at the lineage group level when tasks share a PR, issue, session, or synthetic source.
- Show raw counts and confidence intervals.
- Report practical effect sizes, not only significance.
- Correct or clearly qualify broad multiple-treatment searches.
- Do not make inferential claims for Grafana until it has sufficient real tasks.
- Never select a taxonomy from pooled results while hiding a material repository regression.

## 12. Experiment 0 — Taxonomy-neutral responsibility reference

### 12.1 Question

Can Sol produce stable, evidence-grounded responsibility atoms without seeing a candidate Area
Registry?

### 12.2 Inputs

- all 58 real development tasks;
- all 42 synthetic tasks, reported separately;
- exact task-aware conversation;
- taxonomy-neutral repository profile;
- frozen repository evidence;
- read-only repository snapshot where available.

### 12.3 Treatments

This is reference construction rather than a classifier comparison:

1. `neutral_responsibility_primary`;
2. `neutral_responsibility_repeat`, triggered by Section 8.10; and
3. `neutral_responsibility_adjudication`, when required.

### 12.4 Procedure

1. Remove all candidate area names and current labels from the request.
2. Ask Sol to enumerate concrete implementation responsibilities.
3. Require materiality, affected components, evidence, and confidence.
4. Validate referenced files against the frozen snapshot or evidence artifact.
5. Repeat and adjudicate triggered cases.
6. Freeze the resulting annotations before creating scored taxonomy inputs.

Candidate taxonomies may be proposed from construction data in parallel, but no taxonomy result
may modify a frozen responsibility annotation.

### 12.5 Primary metrics

- valid annotation rate;
- evidence resolution rate;
- repeat atom-set agreement;
- materiality-score agreement; and
- unresolved ambiguity rate.

Atom-set agreement is computed after deterministic text normalization and Sol-assisted alignment
of semantically equivalent atoms. The alignment artifact must be retained.

### 12.6 Readiness gate

Proceed only if:

- at least 95% of real tasks have valid annotations;
- every retained material atom has evidence or an explicit
  `insufficient_information_probability`;
- candidate area names are absent;
- unresolved cases are identified rather than silently forced; and
- the canary cost and output size are within the manifest ceiling.

### 12.7 Outputs

- `neutral-responsibilities.jsonl`;
- `neutral-responsibility-repeats.jsonl`;
- `neutral-responsibility-adjudications.jsonl`;
- ambiguity report;
- evidence-resolution report; and
- content-addressed task package inventory.

## 13. Experiment 1 — Taxonomy basis

### 13.1 Question

Which underlying principle produces areas that Luna can identify while preserving useful
responsibility distinctions?

### 13.2 Controlled variable

Hold the target runtime area count at eight wherever the repository supports eight defensible
areas. Hold card richness at the complete structured format. Change only the taxonomy basis.

If the existing baseline registry does not contain eight areas, retain it as a descriptive
baseline but exclude it from the count-controlled contrast.

### 13.3 Eligible treatments

For each repository:

1. `basis_current`: the existing frozen hybrid registry;
2. `basis_topology_k8`: areas based on repository components and code topology;
3. `basis_ownership_k8`: areas based on CODEOWNERS, maintainers, or team ownership;
4. `basis_responsibility_k8`: areas based on implementation responsibility;
5. `basis_hybrid_k8`: responsibility-first areas anchored to topology and ownership.

### 13.4 Diagnostic controls

1. `basis_vague_control_k8`: generic labels with weak activation rules;
2. `basis_redundant_control_k8`: deliberately overlapping or near-duplicate areas.

Controls use only the screening set and are never eligible for promotion.

### 13.5 Screening set

Freeze a 40-task screening set before any result:

- 16 Backstage tasks: 12 real and 4 synthetic;
- 16 Kubernetes tasks: 12 real and 4 synthetic;
- 8 Grafana tasks: 6 real and 2 synthetic.

Stratify for ordinary, multi-area, boundary, partially unknown, and unknown cases. The same task
IDs are used for every treatment.

### 13.6 Full development set

Promote at most two eligible basis families to all 100 development tasks. Negative controls do
not advance.

### 13.7 Procedure

Each semantic taxonomy runs as a separate experiment manifest with:

- one registry-specific Sol reference treatment;
- one fixed Luna direct treatment; and
- the same tasks and seed.

Different semantic taxonomies must not share one Sol reference because their output dimensions
have different meanings.

### 13.8 Primary comparison

Compare:

- active reference error;
- false-positive mass;
- material-area recall;
- unknown MAE;
- reference ambiguity;
- responsibility coverage; and
- semantic redundancy.

### 13.9 Promotion rule

Promote only taxonomies that:

- beat both diagnostic controls on reference stability and Luna fidelity;
- do not obtain a favorable classifier result through materially lower responsibility coverage;
- have no severe per-repository regression;
- remain on the classification-quality versus taxonomy-utility Pareto frontier; and
- pass all hard registry validity checks.

If topology wins classification but loses substantial responsibility or routing information,
retain both topology and hybrid for Experiment 2 rather than declaring topology the winner.

### 13.10 Decision produced

The result selects one or two preferred taxonomy bases and documents which repository signals
onboarding should prioritize.

## 14. Experiment 2 — Granularity

### 14.1 Question

How many runtime areas should onboarding produce?

### 14.2 Prerequisite

Use the winning or co-winning basis from Experiment 1. Construct one responsibility hierarchy,
then choose different flat cuts from that same hierarchy. This prevents the area count from being
confounded with unrelated definitions.

### 14.3 Treatments

For each eligible repository:

1. `granularity_k4`;
2. `granularity_k8`;
3. `granularity_k12`;
4. `granularity_k20`.

If a repository cannot support a defensible cut exactly at one count, use the nearest count and
record the deviation. No treatment may invent empty areas merely to reach a target.

### 14.4 Construction rules

- Every fine area maps to exactly one parent in the hierarchy.
- All treatments cover the same construction responsibilities as closely as possible.
- Runtime cards contain only the selected flat cut.
- Parent and child areas never coexist in one treatment.
- Card richness remains fixed.

### 14.5 Procedure

1. Run a ten-task transport canary for all four cuts.
2. Run the 40-task screening set.
3. Promote at most three cuts to the complete 100-task development set.
4. Repeat Luna with three seeds on the highest-confusion 20-task subset.

### 14.6 Primary comparison

Do not rank cuts by all-area MAE alone. Compare:

- material-area recall;
- active reference error;
- false-positive mass;
- reference and Luna stability;
- responsibility coverage;
- effective area count;
- rare-area count;
- largest-area share;
- prompt tokens; and
- routing information retained.

### 14.7 Decision rule

Choose the smallest cut that remains on the Pareto frontier after considering classification,
coverage, and routing information. A larger cut is justified only when it preserves a meaningful
responsibility or model-performance distinction and Luna can classify that distinction
reliably.

Report a recommended range, not only one universal number, if repository size materially changes
the result.

### 14.8 Decision produced

The result defines:

- default minimum and maximum area count;
- conditions for exceeding the default;
- minimum evidence required before splitting an area; and
- whether area count should scale with repository task diversity rather than repository size.

## 15. Experiment 3 — Semantic overlap and abstraction level

### 15.1 Question

What overlap should onboarding allow, and which forms of overlap make the composition vector
non-identifiable?

### 15.2 Prerequisite

Use the preferred basis and medium-granularity cut. Keep area count approximately constant.

### 15.3 Treatments

1. `overlap_disjoint`: every responsibility atom has one primary area and boundaries emphasize
   exclusive ownership;
2. `overlap_controlled`: tasks may activate several areas, but each atom has one distinct
   activation reason;
3. `overlap_redundant`: selected area pairs intentionally share 25–40% of mapped responsibility
   mass;
4. `overlap_parent_child`: two or more parent-child pairs coexist in the flat registry.

The last two are diagnostic controls and cannot be promoted.

### 15.4 Required overlap measurements

For every area pair, record:

- weighted semantic-overlap coefficient from responsibility mappings;
- task co-activation rate;
- path-anchor Jaccard;
- confusable-neighbor declaration; and
- Sol and Luna score correlation.

Do not treat path overlap or co-activation alone as semantic duplication.

### 15.5 Procedure

- Use the 40-task screening set.
- Include every task known to activate a manipulated area pair.
- Repeat Sol and Luna three times on at least 20 boundary-heavy tasks.
- Run the complete development set only for disjoint and controlled-overlap treatments.

### 15.6 Primary comparison

- neighbor confusion;
- active recall;
- false-positive mass;
- Sol adjudication rate;
- Luna stability;
- duplicate active-score mass; and
- unknown error.

### 15.7 Decision rule

The final guideline should allow task co-activation but set a semantic-overlap limit at the point
where one of these first occurs:

- active recall falls by at least five percentage points;
- false-positive mass rises materially;
- reference stability cosine falls by at least `0.03`; or
- adjudication rate rises materially.

The precise overlap threshold is selected from development data and frozen before confirmation.

### 15.8 Decision produced

The result defines:

- a semantic-overlap diagnostic and threshold;
- a prohibition or exception rule for parent-child mixing;
- how to document legitimate cross-cutting areas; and
- why path overlap is not a sufficient rejection criterion.

## 16. Experiment 4 — Area Card information

### 16.1 Question

Which Area Card fields are required for Luna to classify a fixed taxonomy?

### 16.2 Reference policy

The Sol reference is created once using the complete Area Registry and neutral responsibility
annotations. It remains fixed for every Luna card ablation. Weakening Luna's card must not
weaken or redefine the reference.

### 16.3 Treatments

All treatments use the same area IDs and semantics:

1. `card_name_only_control`;
2. `card_core`: name, activation rule, description, and inclusions;
3. `card_core_boundaries`: core plus exclusions and confusable neighbors;
4. `card_core_anchors`: core plus paths, components, and symbols;
5. `card_boundaries_anchors`: core plus boundaries and anchors;
6. `card_complete`: boundaries, anchors, positive examples, boundary examples, and multi-area
   rules.

This partial factorial isolates the value of boundaries and repository anchors instead of
testing only one cumulative sequence.

### 16.4 Input controls

- Registry order is fixed.
- Task context and evidence are byte-identical.
- Area Card fields use deterministic ordering.
- Total request limits are fixed.
- If clipping is required, apply the same documented field-priority policy.
- Positive and boundary examples come only from construction data.

### 16.5 Procedure

Because the area semantics are fixed, all Luna card treatments may share one Sol reference in
one manifest:

```text
100 tasks × (1 Sol reference + 6 Luna treatments)
```

Run a ten-task canary first.

### 16.6 Primary comparison

- active reference error;
- material-area recall;
- neighbor confusion;
- unknown MAE;
- Luna stability;
- request tokens; and
- score change on tasks that explicitly name a path versus tasks that do not.

### 16.7 Field requirement rule

A field group becomes required if removing it causes any pre-registered practical degradation:

- at least `0.02` worse active reference error;
- at least three percentage points lower material-area recall;
- at least `0.03` worse unknown MAE;
- a material increase in neighbor confusion; or
- a material stability regression.

If a field improves only path-explicit tasks, make it optional or conditionally generated rather
than universally required.

### 16.8 Decision produced

The result defines the minimum production Area Card schema and an optional enrichment tier.

## 17. Experiment 5 — Coverage, shared areas, and unknown

### 17.1 Question

How complete should an Area Registry be, and when does a catch-all hide genuinely unknown work?

### 17.2 Treatments

Starting from one preferred taxonomy, construct:

1. `coverage_70_no_catchall`: covers approximately 70% of weighted construction
   responsibilities;
2. `coverage_90_no_catchall`: covers approximately 90%;
3. `coverage_98_no_catchall`: approaches exhaustive known coverage;
4. `coverage_90_specific_shared`: adds one positively defined shared-infrastructure area;
5. `coverage_90_vague_other_control`: adds a vague other/miscellaneous area.

Coverage targets are measured from construction responsibilities, never evaluation labels.

### 17.3 Test strata

Report separately:

- fully covered known tasks;
- partially unknown tasks with both mapped and unmapped responsibilities;
- fully unknown repository tasks;
- insufficient-information prompts;
- non-coding or operational requests; and
- synthetic known-known, known-unknown, and unknown-unknown composites.

### 17.4 Procedure

Each semantic coverage treatment receives its own Sol reference and Luna candidate. Use the full
development set and oversample real or derived unknown cases only in a separate diagnostic
report.

### 17.5 Primary comparison

- unknown MAE and Brier score;
- false-known rate at `0.3`, `0.5`, and `0.7`;
- false-unknown rate;
- known-area score distortion when unknown is high;
- responsibility coverage;
- unmapped responsibility mass; and
- frequency with which the shared or other area absorbs unrelated work.

### 17.6 Decision rule

- `coverage_90_vague_other_control` is never eligible for promotion.
- A specific shared area is valid only if it has a positive activation rule, adequate support,
  stable Sol mappings, and lower error than leaving the same work unknown.
- Prefer the least exhaustive registry that preserves routing-relevant responsibilities and
  maintains acceptable false-known behavior.
- Do not multiply known-area scores by `1 - unknown_probability`.

### 17.7 Decision produced

The result defines:

- a construction-coverage target;
- the production rule for shared areas;
- forbidden catch-all patterns; and
- how onboarding should explain intentionally uncovered work.

## 18. Experiment 6 — Routing-aware merging and splitting

### 18.1 Question

Should onboarding merge areas that models handle similarly and split areas whose subareas favor
different models?

### 18.2 Prerequisite

This experiment requires frozen per-model performance evidence for responsibility atoms or
candidate subareas. The evidence must be produced by the separate model-evaluation system and
must not enter Luna or Sol classification prompts.

### 18.3 Treatments

1. `routing_baseline`: preferred classification-first taxonomy;
2. `routing_equivalent_merge`: merge area pairs with similar model-performance vectors;
3. `routing_relevant_split`: split areas whose internal responsibility clusters have materially
   different model rankings;
4. `routing_model_only_control`: cluster work using model performance without responsibility
   coherence.

### 18.4 Frozen routing simulation

Use:

- the same eligible model pool;
- the same per-area performance estimates;
- the same user objective;
- the same purely additive policy;
- no greedy sampling; and
- no tuning from confirmation results.

The simulation exists only to measure whether taxonomy distinctions affect routing decisions.

### 18.5 Primary comparison

- Luna classification metrics;
- responsibility coverage and redundancy;
- frequency of changed top-model decisions;
- area-performance-vector distance;
- merge regret;
- split utility gain; and
- model-only-control reference ambiguity.

### 18.6 Merge rule under test

An area pair is a merge candidate when:

- its model-performance vectors are within a frozen routing-equivalence threshold;
- merging does not hide a policy or safety boundary;
- the merged Area Card remains coherent; and
- the merged registry improves or preserves classification.

### 18.7 Split rule under test

An area is a split candidate only when:

- it contains at least two coherent responsibility clusters;
- the clusters have materially different model rankings or utility;
- each cluster has sufficient real-task support;
- Luna can distinguish them with acceptable stability; and
- the split does not create semantic redundancy with neighboring areas.

### 18.8 Promotion rule

No routing-aware treatment may advance if it materially worsens classification or unknown
detection, even if the routing simulation improves.

### 18.9 Decision produced

The result defines a merge/split review performed after initial responsibility-based area
generation.

## 19. Experiment 7 — Robustness and chronological confirmation

### 19.1 Question

Do the preferred taxonomy and Area Card rules survive realistic prompt variation and future
repository work?

### 19.2 Candidates

Freeze no more than three complete onboarding configurations before using confirmation data.
Each configuration includes:

- taxonomy basis;
- area count rule;
- overlap rule;
- complete Area Registry;
- Area Card schema;
- coverage policy; and
- Luna prompt version.

### 19.3 Confirmation data

- Re-render the existing 24-task Kubernetes confirmation partition with the frozen registries.
- Collect a chronologically later Backstage confirmation set.
- Collect enough additional real Grafana tasks for any Grafana product claim.
- Do not use synthetic composites as the primary confirmation result.

Confirmation execution requires both `paid_execution` and `confirmation` approvals.

### 19.4 Paired robustness transformations

For development diagnostics, create paired transformations that preserve intended
responsibilities:

1. paraphrased request;
2. removal of explicit area names;
3. removal of exact paths;
4. referential conversational follow-up;
5. irrelevant repository-evidence noise;
6. abbreviated specification; and
7. later repository snapshot with compatible task semantics.

Transformations are diagnostics and must be clearly marked synthetic. Original real prompts
remain the primary evidence.

### 19.5 Repetition

Run three Luna seeds for the top configurations on:

- every confirmation task;
- every boundary or multi-area task; and
- every task whose development predictions were unstable.

### 19.6 Primary comparison

- development-to-confirmation degradation;
- per-repository active recall;
- unknown MAE;
- paraphrase stability;
- context-follow-up stability;
- sensitivity to irrelevant evidence;
- reference disagreement; and
- area-support drift.

### 19.7 Confirmation gate

A guideline is not production-ready if it:

- regresses material-area recall by at least five percentage points;
- worsens unknown MAE by at least `0.03`;
- fails primarily on referential or path-omitted prompts;
- depends on explicit area words in the user request; or
- produces a material repository-specific regression hidden by pooled results.

These are practical development gates, not universal scientific constants. They must be frozen
before viewing confirmation results.

### 19.8 Decision produced

The result chooses the first production onboarding rules or explicitly reports that more data is
required.

## 20. Experiment 8 — Automatic onboarding generation and engineer review

### 20.1 Question

What information should onboarding collect, and how much human review is necessary to produce a
valid Area Registry?

### 20.2 Generation arms

For each repository, independently generate registries from:

1. `onboarding_tree`: repository tree, manifests, and language/framework detection;
2. `onboarding_docs_ownership`: tree plus documentation, CODEOWNERS, maintainers, and package
   metadata;
3. `onboarding_history`: the prior arm plus construction-only issues, PRs, and coding-session
   tasks;
4. `onboarding_routing`: the prior arm plus separate model-performance evidence used only during
   merge/split review;
5. `onboarding_engineer_review`: the best automatic proposal followed by one lightweight owner
   review.

Generate at least three independent proposals per automatic arm to measure generator stability.

### 20.3 Generator constraints

The generator receives the final constraints learned from Experiments 1–6. It must:

- produce the registry schema in Section 9;
- cite evidence for every area;
- report unsupported or low-support areas;
- report overlap diagnostics;
- keep routing evidence separate from runtime cards;
- propose merges and splits explicitly;
- avoid validation and confirmation tasks; and
- output a machine-readable constraint report.

### 20.4 Engineer review protocol

The reviewer may:

- rename an area;
- edit activation rules or boundaries;
- merge or split areas;
- delete unsupported areas;
- add missing areas; and
- approve the registry.

Record:

- review duration;
- number and type of edits;
- before/after registry hashes;
- reasons for changes; and
- whether the reviewer saw any evaluation result.

The reviewer must not see development or confirmation classifier scores before completing the
edit.

### 20.5 Evaluation

Evaluate every generated registry with a frozen diagnostic subset. Evaluate only the best
automatic and reviewed registries on the full development or confirmation data.

### 20.6 Primary comparison

- hard constraint pass rate;
- classification quality;
- responsibility coverage;
- semantic redundancy;
- independent-generation stability;
- engineer edit count;
- review time;
- unsupported-area rate; and
- improvement from review.

### 20.7 Decision produced

The result defines:

- required onboarding data sources;
- the automatic proposal process;
- the registry linter;
- the merge/split review;
- the minimum engineer approval step; and
- conditions that require collecting more task history before onboarding completes.

## 21. Experiment sequencing

Run in this order:

```text
Experiment 0: neutral responsibility annotations
        |
        v
Experiment 1: taxonomy basis
        |
        v
Experiment 2: granularity
        |
        +------> Experiment 3: overlap
        |
        +------> Experiment 4: Area Card fields
        |
        v
Experiment 5: coverage and unknown
        |
        v
Experiment 6: routing-aware merge/split
        |
        v
Experiment 7: robustness and confirmation
        |
        v
Experiment 8: automatic onboarding workflow
```

Experiments 3 and 4 may run in either order after Experiment 2. Do not run the full Cartesian
product of all variables. Use staged screening to avoid spending most of the budget on obviously
weak combinations.

## 22. Manifest and reducer design

### 22.1 One semantic taxonomy per composition manifest

The current composition reducer permits exactly one reference treatment per task and seed.
Therefore:

- a manifest may contain one Sol reference plus several Luna treatments only when all treatments
  use the same area IDs and semantics;
- different taxonomy bases, granularities, overlap definitions, or coverage definitions require
  separate manifests; and
- a new meta-reducer compares registry-level metrics across completed manifests.

### 22.2 Required manifest metadata

Every task or treatment configuration must record:

- `registryId`;
- `registryHash`;
- `areaCount`;
- `taxonomyBasis`;
- `cardVariant`;
- `referenceMode`;
- `taskPackageHash`;
- `neutralResponsibilityHash`; and
- experiment phase.

### 22.3 Vercel execution roles

- Hosted-model Queue jobs run Luna and evidence-only Sol requests.
- Sandbox jobs build registries, validate paths, inspect frozen repositories, calculate
  diagnostics, and run meta-reduction.
- Tool-using Sol construction requires a dedicated bounded harness in Sandbox or a precomputed
  tool trace; the current hosted-model worker alone does not provide repository tools.
- Workflow coordinates canaries, approvals, staged promotion, and reporting.

### 22.4 Required implementation before execution

Before submitting Experiment 0:

1. add the neutral responsibility and registry-mapping schemas;
2. add registry validation and leakage checks;
3. create a taxonomy-neutral repository-profile renderer;
4. regenerate task packages without current-registry leakage;
5. add taxonomy diagnostic metrics;
6. add the cross-manifest meta-reducer;
7. freeze or upload the Backstage snapshot store if full-repository Sol is required;
8. build and publish a new immutable runner image;
9. upload new content-addressed artifacts; and
10. create canary manifests with conservative budgets.

### 22.5 Artifact layout

Use content-addressed Blob paths and retain a local ignored inventory:

```text
area-taxonomy-v1/
  datasets/
    construction/
    development/
    confirmation/
  repositories/
    <repository-id>/
      snapshots/
  responsibilities/
    neutral/
    repeats/
    adjudications/
  registries/
    <repository-id>/
      <registry-id>/
        registry.json
        constraint-report.json
        construction-mappings.jsonl
  task-inputs/
    <registry-id>/
      <task-id>.json
  references/
    <registry-id>/
      <task-id>.json
  predictions/
    <experiment-id>/
  metrics/
    within-registry/
    cross-registry/
    routing-utility/
  reports/
```

Every inventory entry records the byte size, SHA-256 digest, Blob pathname, data role,
repository ID, source commit, generator version, and whether it contains private content.
Model-facing JSON may use the snake-case contract in this specification; TypeScript codecs may
normalize it internally, as the existing composition reducer does.

## 23. Budget specification

The current composition manifests conservatively reserve:

- `$0.05` per Sol call;
- `$0.01` per Luna call.

A paired Sol-plus-Luna task therefore reserves `$0.06`.

Planning examples:

- one 10-task paired canary: `$0.60`;
- one 40-task taxonomy screen: `$2.40`;
- one 100-task full taxonomy: `$6.00`;
- the full Area Card experiment with one Sol and six Luna calls per task: up to `$11.00`.

Repeat and adjudication calls require additional reservation. Actual estimates must be refreshed
from the preceding canary.

The current `$15` AI Gateway key budget does not authorize the complete multi-experiment program.
Before each phase:

1. calculate the exact task × treatment × seed count;
2. include triggered-repeat headroom;
3. set a manifest ceiling;
4. verify the dedicated key has a larger remaining budget than the manifest ceiling;
5. submit only after explicit approval; and
6. never raise one global budget merely to avoid phase-level review.

## 24. Reports

Every experiment report must include:

1. research question and frozen hypothesis;
2. repositories, task counts, roles, and lineage;
3. registry IDs, hashes, area counts, and construction inputs;
4. exact Luna and Sol configurations;
5. reference mode: full repository or evidence only;
6. real and synthetic results separately;
7. per-repository and per-area results;
8. reference disagreement and adjudication;
9. taxonomy coverage, redundancy, and support;
10. highest-impact failures;
11. cost and call counts;
12. practical interpretation;
13. what the experiment cannot prove; and
14. the exact decision or next-stage candidates.

The final cross-experiment report must present:

- the selected taxonomy basis;
- recommended area-count range;
- allowed and forbidden overlap;
- required Area Card fields;
- coverage and shared-area policy;
- routing-aware merge/split rules;
- robustness evidence;
- onboarding data requirements;
- engineer-review requirements; and
- unresolved uncertainty.

## 25. Candidate onboarding constraints to validate

These are provisional hypotheses, not final rules:

1. Use responsibility-first areas anchored to repository-native paths and ownership.
2. Keep all runtime areas at one abstraction level.
3. Give every area one unique activation reason.
4. Allow multi-area tasks but reject duplicated ownership of one responsibility.
5. Require explicit inclusions, exclusions, confusable neighbors, and multi-area rules.
6. Treat paths and symbols as evidence, not as the sole definition.
7. Prohibit vague catch-all areas.
8. Require enough historical support for every ordinary area; mark rare safety- or
   policy-critical exceptions explicitly.
9. Merge areas that are semantically coherent and routing-equivalent.
10. Split an area only when the subareas are coherent, supported, classifiable, and
    routing-relevant.
11. Validate the registry on historical tasks before onboarding completes.
12. Require a lightweight engineer approval for the first product version.

Experiments 1–8 must either support, modify, or reject each provisional rule.

## 26. Definition of done

This research program is complete only when:

1. taxonomy-neutral responsibility annotations are frozen and audited;
2. at least two repositories have enough real data for a comparative conclusion;
3. basis, granularity, overlap, card, coverage, and routing-aware experiments are complete;
4. diagnostic controls behave worse than valid candidates;
5. reference ambiguity is measured rather than hidden;
6. the selected rules pass chronological confirmation;
7. automatic onboarding has been evaluated against a reviewed registry;
8. all artifacts are content-addressed and reproducible;
9. no locked data entered the development project;
10. all paid calls remained within explicit manifest ceilings;
11. one versioned onboarding guideline is recommended; and
12. the final report states where more data is still required.

## 27. Execution prohibition

This file is a design specification. Creating or merging it does not authorize:

- uploading new private data;
- submitting an experiment;
- approving paid execution;
- invoking Luna or Sol;
- using confirmation data;
- creating a locked evaluator; or
- changing the AI Gateway budget.

Those actions require separate explicit approval.
