# RouteKit end-to-end verification matrix

Run the credential-free matrix:

```bash
pnpm test:e2e:matrix
```

It exercises the five launch provider classes (`openai`, `anthropic`,
`openrouter`, `codex`, and `claude-code`) through the OpenAI Chat, Anthropic
Messages, and Responses HTTP boundaries. It also launches every installed
coding-agent CLI through the real
`routekit` command in a tmux PTY. Each CLI case selects a non-default
namespaced model, types a deterministic prompt, waits for a response, and
checks the model that reached the gateway. Claude Code and Codex additionally
execute a simulator-scripted safe shell tool call. The existing subscription
pool suite covers eligible-account selection, proactive quota switching,
quota failover, transient throttling, and all-members-unavailable exhaustion.
The `native-pickers` case also verifies that Claude Code sees `claude-code/*`
as bare Claude names, Codex sees `codex/*` as bare Codex names, duplicate
namespaced entries are absent from those pickers, and the global OpenAI catalog
remains namespaced.

The deterministic `anthropic-thinking` case routes both buffered and
pathologically chunked streaming Messages requests through the canonical
`claude-code` provider backend. It asserts exact adaptive controls, signed
assistant-history replay, `signature_delta`, `redacted_thinking`, and separation
of thinking from answer text.

The deterministic `dynamic-reasoning-capabilities` case verifies that ordered
opaque effort IDs and config provenance survive model discovery, that a
supported value reaches OpenRouter egress, and that an unavailable value is
rejected with `400` before provider transport.

Transactional account activation has a separate process-interruption record:
[RouteKit transactional account activation evidence](routekit-account-activation-evidence.md).
It covers an actual child `SIGKILL`, daemon startup recovery, injected
connector failure, idempotent replay, and transaction-journal redaction without
copying provider credentials into artifacts.

Per-request routing and billing inspection has a separate protocol and privacy
record: [RouteKit request attribution evidence](routekit-request-attribution-evidence.md).
It covers model-call correlation, effective/native model identity, provider and
billing mode, subscription-seat attempts and failover, usage/cost state,
bounded retention, human/JSON CLI output, and automated secret redaction.

## Live real-account mode

Live calls are disabled unless explicitly authorized:

```bash
ROUTEKIT_LIVE_E2E=1 pnpm test:e2e:matrix
```

Live mode first reruns the deterministic matrix, then starts RouteKit with
`.routekit/router.yaml`. Failure to discover any configured provider is a
failure. An installed CLI that cannot complete is also a failure; a missing
optional CLI is an explicit skip. Prompts and HTTP output limits are kept
small. The default hard limit is 48 client-to-RouteKit model requests,
including extra agent turns such as a tool result or OpenCode title generation.
This is not an invoice or provider-egress counter: a provider backend can make
bounded internal retries or same-kind subscription rotations after one gateway
request. Authorize provider-account spend separately under the route's
documented retry policy.

Live mode repeats the native-picker assertions for configured Claude Code and
Codex providers. Catalog checks do not issue model-generation requests and
therefore add zero live model requests.

Before generation cases, live mode also runs
`routekit --json models info <provider/model>` for one discovered model from
every configured provider. It writes the secret-free contract fields to
`live-route-info.json`, verifies the native model and provider, and rejects any
configured credential value in command output. This route-explanation check
starts an isolated singleton daemon and adds zero model-generation calls.

When `claude-code` and the `pool` door are selected, live mode also loads the
real enrolled account set, injects a quota response for the first selected
member, and asserts that the second member succeeds and becomes active. The
fault and success response are local, so this failover case consumes no model
quota and writes cooldown state only under the temporary matrix directory.

Useful filters:

```bash
pnpm test:e2e:matrix -- --provider openrouter,codex
pnpm test:e2e:matrix -- --door openai-chat,claude
ROUTEKIT_LIVE_E2E=1 pnpm test:e2e:matrix -- \
  --provider claude-code --door pool --max-live-calls 1
ROUTEKIT_LIVE_E2E=1 pnpm test:e2e:matrix -- \
  --model openrouter=openrouter/openai/gpt-4.1-nano \
  --timeout-ms 180000 --max-live-calls 20
```

The equivalent environment filters are `ROUTEKIT_E2E_PROVIDER`,
`ROUTEKIT_E2E_DOOR`, `ROUTEKIT_E2E_TIMEOUT_MS`, and
`ROUTEKIT_E2E_MAX_LIVE_CALLS`.

## L06 real-account qualification

ENG-679 qualifies the six first-launch routes by their stable L05 anchors:

```bash
ROUTEKIT_LIVE_E2E=1 pnpm test:e2e:matrix -- \
  --route route-openai-api,route-anthropic-api,route-openrouter-api,\
route-codex-subscription,route-claude-code-subscription,route-cursor-ide \
  --max-live-calls 32
```

`--route` cannot be combined with the lower-level `--provider` or `--door`
filters. Prefer one route per invocation while diagnosing a failure. This keeps
credential discovery and live traffic attributable:

```bash
ROUTEKIT_LIVE_E2E=1 pnpm test:e2e:matrix -- \
  --route route-openai-api --max-live-calls 1
```

The qualification descriptors live in
[`scripts/routekit-qualification.mjs`](../scripts/routekit-qualification.mjs).
They intentionally omit Google, Gemini, Grok, Kimi, CLIProxy, OpenCode, MLX,
and every other Not offered route. The live router config is generated in the
matrix temporary directory; qualification does not edit the committed
`.routekit/router.yaml` or import it into the daemon.

### Preflight and account modes

Check availability without printing a credential or account identifier:

```bash
for name in OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY; do
  test -n "${!name:-}" && echo "$name=set" || echo "$name=unset"
done
command -v claude codex
```

- OpenAI, Anthropic, and OpenRouter use their named environment variables.
- Codex and Claude Code require enrolled RouteKit subscription accounts and
  their corresponding official client versions.
- Cursor requires an authenticated desktop client whose custom OpenAI endpoint
  a reviewer configures by hand. There is no automated launcher, so a run
  without that manual evidence is a **Fail**, not a Skip.

Never echo token values, inspect credential JSON, or copy account filenames
into evidence. A missing key, client, login, or account is a route-level Fail
with a fixed reason code.

### Request and spend controls

Every route reserves a conservative gateway-request maximum before live execution. The matrix
refuses to start if the selected routes cannot fit within
`--max-live-calls`; the local counting proxy enforces the same cap at request
time. API and subscription HTTP routes reserve one gateway request each. The
Cursor descriptor reserves one request, but the runner records that route as
Fail without issuing it.

The cap does not observe provider-internal retries and must not be represented
as a provider-request or billing limit. API routes have no RouteKit retry or
fallback. Subscription retries and same-kind rotation remain bounded by the
route contract; run those routes individually with an account-level spend
authorization.

Deterministic checks run before live traffic and prove:

- streaming, tool-call, and reasoning transport for each selected protocol;
- client cancellation propagates to the upstream response body;
- a selected provider failure reaches the caller and makes zero calls to every
  other configured provider.

These checks establish RouteKit behavior without intentionally causing a paid
provider failure. Live mode then proves the real credential/account and model
path with a small streamed response. OpenRouter's provider-managed upstream
routing remains distinct from RouteKit fallback.

### Cursor evidence

RouteKit ships no Cursor launcher or desktop harness, so this route has no
automated evidence path. Qualifying it means a reviewer configures Cursor
Settings -> Models -> Override OpenAI Base URL against the gateway on the same
RouteKit revision, drives one Agent turn, and records the observed gateway
call. The route permits exactly one model call.

Cancellation, failure propagation, and no RouteKit fallback come from the named
passing deterministic matrix cases, not from the editor. Until that manual
review exists, the route stays Fail with `manual-evidence-unavailable`.

Self-authored JSON is not a trust boundary. The L06 generator rejects legacy or
free-form manual records and re-derives schema-3 reviewed records from the
bound matrix before applying them.

For Codex and Claude Code, the live runner copies only the selected enrolled
credential files into its mode-`0600` temporary RouteKit home, verifies the
source account store is unchanged after shutdown, and removes the temporary
home. File names, contents, and individual digests are never
serialized. A response alone does not prove setup/restore; every required setup
and restore outcome must pass. API-key routes correctly mark setup/restore as
not applicable.

## Artifacts and interpretation

Each run writes a timestamped `report.json` and sanitized PTY transcripts under
`.artifacts/routekit-e2e/`. This directory is ignored by Git. The report has
exact case and route pass/fail/skip counts, top-level failure count, per-case
duration and gateway-request counts, and the total number of client-to-RouteKit
model requests observed at the local counting proxy. Every result has a stable
`caseId` and the applicable L05 `routeIds`; cases for not-offered doors such as
OpenCode deliberately have an empty `routeIds` list.
Schema version 4 also records the exact Git SHA, RouteKit and client versions,
authorized budget, selected route anchors, fixed reason codes, route
capabilities, billing basis, setup/restore outcomes, evidence-map digest, exact
source revision and dirty state, and completeness.
PTY cases isolate RouteKit and XDG runtime state and disable CLI auto-updaters
so test runs cannot rewrite user-level executable links.

- `pass`: the boundary or real CLI completed and routed the requested model.
- `fail`: a configured provider, installed door, response, model-selection, or
  safe-tool assertion regressed.
- `skip`: an optional CLI binary was not installed, with the reason recorded.

Provider credentials are never copied into artifacts. Review the report before
using a wider filter or increasing the call budget. `.artifacts` is diagnostic
and must not be linked as durable L06 evidence. Publish only an allowlisted,
reviewed report under `docs/evidence/`; never commit PTY transcripts, prompts,
responses, authorization headers, account identifiers, or local paths.

### Reviewed manual-evidence workflow

Start from a clean tree and preserve the tested revision:

```bash
test -z "$(git status --porcelain)"
REVISION="$(git rev-parse HEAD)"
ROUTEKIT_LIVE_E2E=1 pnpm test:e2e:matrix -- \
  --route route-openai-api,route-anthropic-api,route-openrouter-api,\
route-codex-subscription,route-claude-code-subscription,route-cursor-ide \
  --max-live-calls 32
```

The matrix command is expected to exit nonzero while the three route summaries
remain gated by `manual-evidence-unavailable`. Use the printed schema-4
`REPORT` path; do not edit it. Codex and Claude Code reviewed records are
derived from their qualification rows and all mapped/supporting case
results—there are no operator-authored summaries.

Generate the reviewed records. Cursor has no machine-reviewable record, so it
is never part of this projection:

```bash
node scripts/generate-routekit-manual-records.mjs \
  --matrix-report .artifacts/routekit-e2e/<run>/report.json \
  --revision "$REVISION" \
  --output .artifacts/routekit-e2e/<run>/reviewed-manual-records.json
```

Finally, promote the exact matrix and generated records:

```bash
node scripts/generate-routekit-l06-evidence.mjs \
  --matrix-report .artifacts/routekit-e2e/<run>/report.json \
  --revision "$REVISION" \
  --manual-records .artifacts/routekit-e2e/<run>/reviewed-manual-records.json
```

The command rejects dirty, incomplete, stale-mapping, count-inconsistent, or
identity-forged reports, credential-shaped content, zero/over-budget
observations, unavailable versions, failed protocol/behavior/setup/restore,
and records that are not the exact trusted projection. It then regenerates
`docs/routekit-l06-evidence.{json,md}`. Cases absent from a filtered run and
manual records not supplied with that promotion revert to `pending`; prior
passes and revision-specific client, provider, and credential metadata are
never carried to a new revision. Manual-record files must name the same full
`testedRevision`, matrix digest, and evidence-map digest. CI reruns the
generator with `--check`, so a mapping change or hand-edited durable report
fails closed. Promotion never changes a row to `qualified` unless every mapped
machine case, exact version, bounded gateway observation, protocol/behavior
outcome, and setup/restore check passes.
