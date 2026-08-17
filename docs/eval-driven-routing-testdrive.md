# Eval-driven routing — agent brief

Make the `support` profile loop test-driveable through the **repo CLI**.
No `host.mts`. No planted snapshot. No Ori binary.
Ignore `FEATURE_COMPLETENESS.md` / `HOST.md` / the orange changeset — those are not this product.

**Re-measured 2026-08-15 after pull `387caf0`.** G1–G4 on orbit. G5 on isolated eval-dev (this checkout + mock OpenAI), not orbit.

---

## Job

Same profile id `support`, one sitting:

1. Interview (one question/turn, resume after interrupt).
2. Write `.routekit/evals/support/support.eval.ts` (`import { setupAgent, setupJudge } from "routekit/eval"`) and `.routekit/routing/support.yaml`.
3. Paid comparison on orbit: ≥2 candidates + 1 judge. Models: **`codex/*` and `claude-code/*` only** (OpenAI spend-capped, Anthropic API broke, OpenRouter hung).
4. On publish approval, write `$ROUTEKIT_HOME/eval/published-routing.v1.json`.
5. `model: auto` + `x-routekit-profile: support` hits the published winner. Eval traffic cannot use `auto`.

Done = G1–G5 pass. Return the checklist with commands.

---

## Rules

- **Tests use repo CLI only:** `node packages/cli/dist/index.js` or `pnpm dev:run-routekit`. Build if `dist` is missing. Global `routekit` is for remotes/tokens/models only.
- **`eval run` ignores `--remote`.** Read orbit URL/token from global `routekit remote show orbit` / Keychain `routekit-remote`/`orbit`, pass `--url` `--token` into the repo CLI.
- **Do not extend `eval run --spec` JSON.** That is one-candidate `runEvalSuite`. Host the `*.eval.ts` stack (`eval-setup` → `eval-engine` → `eval-service` → snapshot).
- **Dual Effect:** `eval-engine` = `4.0.0-beta.99`. Everything else = `4.0.0-rc.108`. Cross with data only (`EvalComparisonRequest` → `EvalComparisonResult`). No shared `Layer`.
- **Keep isolation:** bypass + attribution headers; reject `auto`/`router`/`default`; token stays in the parent bridge; online path does not import eval-engine.

Already built (wire, don’t rewrite): `eval-setup` interview + scaffolder, `eval-engine` `runComparison`, `compileRoutingPolicy`, `RoutingSnapshotStore.publish`, daemon/gateway auto consume in **this** source, `EvalSetupRunnerFromEvalService` (needs a real runner).

---

## Gates

| Gate | Pass | Measured |
|---|---|---|
| G1 Host | Repo `eval --help` lists interview + run + publish. | **Pass.** `prepare` `status` `answer` `validate` `estimate` `run` `publish`. |
| G2 Interview | 7 stages in this repo. Suite + yaml exist. Estimate before spend; unknown ≠ 0. | **Pass.** `prepare` ~2s. Estimate: 12 calls, cost unmeasured. Candidates prompt now requires 3 unique IDs. |
| G3 `*.eval.ts` | Product command runs the suite on orbit. ≥2 models with `cases.length > 0`. | **Pass.** `eval run` vs orbit, comparison `fcc2296c-…`, ~46s. Haiku + `codex/gpt-5.4-mini`, 3 cases each. All 6 **failed** the judge (seed prompts). Winner still proposed: `codex/gpt-5.4-mini`. |
| G4 Publish | `~/.routekit/eval/published-routing.v1.json` has `profiles.support`. | **Pass.** `selectedModel: codex/gpt-5.4-mini`, fallback haiku. Written to **this machine’s** `$ROUTEKIT_HOME`, not orbit. |
| G5 `auto` | this-checkout daemon: `model=auto` + `x-routekit-profile: support` → 200. | **Pass on eval-dev** `http://127.0.0.1:18080`. Orbit still `400 unknown model: auto` (do not roll this out). |

G0 (not your bug): orbit healthy, Keychain token, Node ≥22.22, repo CLI built, `codex/*` + `claude-code/*` served.

---

## Build this, in order

1. **CLI host** for `EvalSetup`: prepare / answer / status / validate / estimate / runApproved / publishApproved. Skill is optional, not the only entry.
2. **Adapter:** `EvalComparisonRunner` → `makeRouteKitEvalExecutionPort` inside engine Effect; return plain `EvalComparisonResult`. Implement `estimate`.
3. **`snapshotRoot = $ROUTEKIT_HOME/eval`.**
4. **Interview/suite:** cap/skip inspect (`node_modules`, `.git`, `dist`). Canned candidate options must yield IDs or be rejected. `explicitModels` is a `Set` — need 3 unique IDs (2 candidates + judge). Scaffold must loop those IDs, pin judge to a RouteKit id (not `~anthropic/claude-opus-latest`), and write real cases (copy says “three-case pilot”, file has one stub).
5. **CLI runs `*.eval.ts` via eval-engine**, not `runEvalSuite`. Empty `cases: []` → compiler rejects the model.
6. **G5:** deploy this gateway to orbit, or prove auto on a daemon from this checkout and say which.

Later (don’t): spend-limit enforce, reports/history, tools/streaming, Effect beta migration, eval token plane, `eval-worker`.

---

## What’s already in this repo

```
.routekit/evals/support/support.eval.ts   # stub case; haiku + gpt-5.4-mini; judge sonnet
.routekit/routing/support.yaml
.routekit/eval-setup/support/state.json   # STALE (stage: surface). Reset it.
```

`routekit/eval` appears only when the engine runs. Missing-import in the editor is expected.

---

## Orbit probes (JSON stack — not the goal)

`node packages/cli/dist/index.js eval run --spec … --url https://orbit-gateway.velum.sh --token …`

| Model | Result |
|---|---|
| `openai/gpt-4o-mini` | 429 spend limit |
| `anthropic/claude-haiku-4-5-20251001` | no credits |
| `openrouter/liquid/lfm-2.5-2.6b:free` | hung, killed |
| `claude-code/claude-haiku-4-5-20251001` | `eval_2bde08f52f90` in 3s. Candidate `Blue.`; judge `**Pass**`; suite **fail** (`expected` `"blue"` is case-sensitive). No snapshot. |

`codex/gpt-5.4-mini` was called in the G3 `*.eval.ts` run (3 cases, all judge-failed).

Online snapshot file is **`published-routing.v1.json`**, not `published.v1.json` or `raw/`.

## Eval-dev gateway (G5 only)

Isolated home `~/.routekit-eval-dev`. OpenAI-only config + local mock. Does not touch orbit, `~/.routekit`, or `~/.config/routekit/router.yaml`. Snapshot there is rewritten to `openai/gpt-4o-mini` so the mock catalog can serve `auto`.

```bash
~/.routekit-eval-dev/start.sh   # http://127.0.0.1:18080  token rk_eval_dev_local_token
~/.routekit-eval-dev/stop.sh
```

`curl` `model=auto` + `x-routekit-profile: support` + `Authorization: Bearer rk_eval_dev_local_token`.

---

## Checklist (return this)

- [x] G1 interview + run + publish on repo CLI
- [x] G2 interview finishes in this repo; yaml is `codex/*` + `claude-code/*`
- [x] G3 repo CLI runs `support.eval.ts` on orbit; ≥2 models have cases
- [x] G4 `~/.routekit/eval/published-routing.v1.json` has `support`
- [x] G5 `auto` + profile header → 200 on eval-dev (`127.0.0.1:18080`); orbit still unknown `auto`
- [x] no `host.mts`, no planted snapshot, no Ori
