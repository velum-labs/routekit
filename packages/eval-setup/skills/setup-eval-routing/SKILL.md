---
name: setup-eval-routing
description: Set up eval-driven RouteKit model routing for one model-backed workflow. Trigger when the user asks which model to use, wants model:auto backed by measurements, asks to compare models for an application flow, or asks RouteKit to create the evals needed for routing. Do not trigger merely to run an existing eval or for model-free unit tests.
metadata:
  command-aliases:
    - eval-routing
---

# Set Up Eval Routing

Create one measured routing profile at a time. The finished loop is an editable
`routekit/eval` suite, an explicit candidate and judge configuration, a paid run
approved by the user, and a separately approved published routing policy.

Use RouteKit's `EvalSetup` operations. Do not reproduce engine, storage, or
policy logic in this skill, and do not invoke a standalone eval executable.

## Workflow

1. Call `prepare(repositoryRoot, profileId)`. It inspects the repository before
   asking anything and resumes durable state when setup was interrupted.
2. Show the returned repository context, then relay exactly the returned
   `question`. Ask one question and stop. Keep its three concrete options and a
   free-text `Other` option.
3. Pass the user's answer unchanged to `answer`. Never answer a setup question
   yourself. If the user asks for clarification, explain and ask the same open
   question again without submitting an answer.
4. Continue one question per turn through these stages:
   - `[surface]`: choose one model-backed workflow.
   - `[data]`: choose real fixtures, sanitized traffic, or disclosed seed cases.
   - `[criteria]`: define acceptable behavior.
   - `[constraints]`: select the objective after the quality floor.
   - `[candidates]`: provide explicit `provider/model` candidate IDs followed by
     the explicit judge model. Never use `auto`, `router`, `default`, or aliases.
   - `[spend-approval]`: pilot, full comparison, or save without running.
   - `[publish]`: publish, keep unpublished, or run another comparison.
5. When artifacts are generated, show their paths. The eval must import:

   ```ts
   import { setupAgent, setupJudge } from "routekit/eval";
   ```

6. Call `validate` before discussing a paid run. Report missing or unknown
   measurements as unknown, never zero.
7. Call `estimate` for a pilot or full run. State call count, maximum cost when
   pricing is known, and say explicitly when pricing is unknown.
8. Call `runApproved` only after `[spend-approval]` approved pilot or full.
9. Present the proposed winner, fallbacks, rejected candidates, quality, cost,
   latency, reliability, sample count, and unknown values before `[publish]`.
10. Call `publishApproved` only after the user explicitly approves publication.

## Safety and quality rules

- Inspect before asking. Do not ask for facts already present in the repository.
- One question per turn. Never combine stages or continue on an assumed answer.
- Prefer existing tests and fixtures, then sanitized real examples. Synthetic
  cases are a disclosed fallback, not production evidence.
- Never send sensitive data without the user's decision that it is safe.
- Never spend or publish silently.
- Candidate and judge roles stay separate and always use explicit model IDs.
- Eval traffic must bypass `model: auto`; the measured router must not evaluate
  itself recursively.
- Do not log, persist, echo, or place credentials in generated artifacts.
- Generated files are transparent and user-editable under `.routekit/evals/`
  and `.routekit/routing/`.
- After interruption, call `status` or `prepare` and resume the existing open
  question. Do not repeat completed answers or duplicate a paid run.
