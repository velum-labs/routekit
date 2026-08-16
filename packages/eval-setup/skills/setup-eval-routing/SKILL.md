---
name: setup-eval-routing
description: Set up eval-driven RouteKit model routing for one model-backed workflow. Trigger when the user asks which model to use, wants model:auto backed by measurements, asks to compare models for an application flow, or asks RouteKit to create the evals needed for routing. Do not trigger merely to run an existing eval or for model-free unit tests.
metadata:
  command-aliases:
    - eval-routing
---

# Set Up Eval Routing

Create one measured routing profile at a time. RouteKit is a thin façade over
the supported eval authoring library. Interview questions, case selection,
execution, and judging come from that library. RouteKit keeps profile id,
objective, eligibility, and publication.

Use RouteKit's `EvalSetup` operations. Do not reproduce engine, storage, or
policy logic in this skill, and do not invoke a standalone eval executable.

## Workflow

1. Call `prepare(repositoryRoot, profileId)`. It creates or resumes durable
   authoring state. It does not spend.
2. Call `runApproved` to start one author turn. Relay exactly the returned
   `question` and `question.context`. Ask one question and stop.
3. Pass the user's answer unchanged to `answer`. Never answer a setup question
   yourself. If the user asks for clarification, explain and ask the same open
   question again without submitting an answer.
4. Continue one question per turn. Do not invent RouteKit stages, case counts,
   or candidate lists. The library owns five-candidate and 10-15-case defaults.
5. When the run is `completed`, the suite lives in the scratch workspace until
   publication copies it under `.routekit/evals/<profile>/`.
6. Call `validate` only after an authored artifact exists. It dry-loads that
   suite and must not execute test bodies.
7. Call `estimate` only after the library has reported totals. State those
   reported values. Missing cost is unknown, never zero.
8. Call `publishApproved` only after the user explicitly approves publication.
   Publication compiles already-measured evidence. It does not rerun paid calls.

## Safety and quality rules

- One question per turn. Never combine questions or continue on an assumed answer.
- Never send sensitive data without the user's decision that it is safe.
- Never spend or publish silently.
- Candidate and judge roles stay separate and always use explicit model IDs.
- Eval traffic must bypass `model: auto`; the measured router must not evaluate
  itself recursively.
- Do not log, persist, echo, or place credentials in generated artifacts.
- After interruption, call `status` or `prepare` and resume the existing open
  question. Do not repeat completed answers or duplicate a paid run.
