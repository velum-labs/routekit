# Testing RouteKit

How this repository tests the product, what tooling exists for it, and how to
write new tests against that tooling. The goal is a specific fidelity contract:
**tests drive the real RouteKit daemon and gateway, with a scriptable provider
simulator as the upstream when live credentials are absent.**

## The problem this tooling solves

RouteKit is a chain of real processes and wire protocols:

```
coding tool ──(OpenAI/Anthropic/Responses dialects)──▶ RouteKit gateway
    RouteKit gateway ──(provider adapters/accounts)──▶ model providers
```

The shared provider simulator exercises neutral wire parsing, SSE chunk
reassembly, subscription pool behavior, and process startup without requiring
real provider accounts in CI.

## The tooling

### 1. Provider simulator — `routekit-sim`

`routekit-sim` is a scriptable HTTP server that speaks the provider surfaces
RouteKit exercises in tests:

- **OpenAI-compatible Chat Completions** (`POST /v1/chat/completions`): JSON
  and SSE streaming with realistic chunking.
- **Anthropic Messages**, **OpenAI Responses (Codex wire)**, and **Google GenAI**
  routes used by the gateway dialect adapters.

**Control plane** (scriptable): behaviors are queued per model name, FIFO;
an unqueued call gets a deterministic echo default. A behavior can carry a
reply, tool calls, out-of-band reasoning, an HTTP error, injected latency,
stream pacing, or a deliberately broken stream.

**Observation plane** (instrumentable): every request is journaled. Tests assert
on the journal (`GET /__sim/journal`): what actually crossed the provider wire,
not whether a mock function was called.

The simulator is maintained in a sibling checkout (set `ROUTEKIT_SIM_ROOT` to
that repository root). `@velum-labs/routekit-testkit` spawns it as
`routekit-sim --port 0` and scripts it over the HTTP control plane. When the
simulator or `uv` is absent, cross-stack suites self-skip with an explicit
reason. Disable stack tests with `ROUTEKIT_E2E_STACK=0`.

### 2. Node testkit — `packages/testkit` (`@velum-labs/routekit-testkit`, never published)

- `startProviderSim()` — spawns the simulator, returns a handle that scripts
  it over the control plane (`queue` accepts plain strings or behaviors) and
  reads the journal (`journal` / `journalFor` / `calls(filter)` /
  `describeJournal` / `reset`), with the child's log for diagnostics.
- `DOOR_PROFILES` / `callDoor()` — one profile per gateway front door (OpenAI
  chat, Anthropic Messages, Codex Responses, Cursor BYOK hybrid).
- `parseSse` / `sseText` / `sseReasoning` / `sseDone` — structured SSE
  observation.
- `stackToolingSkip()` / `detectStackTooling()` — honest skip-gating for the
  external simulator checkout.
- `spawnCaptured` / `waitForHttpReady` / `freePort` — observable process
  plumbing shared by the above.

### 3. Real coding-agent CLI harnesses — `@velum-labs/routekit-testkit` `clis.ts`

`runClaudeCode(...)` / `runCodexExec(...)` / `runOpenCode(...)` spawn the
actual `claude`, `codex`, and `opencode` binaries against a gateway URL. No
mocked tool clients. `cliAvailable` / `cliSkip` gate suites where the binaries
are missing.

### 4. E2E matrix — `scripts/routekit-e2e-matrix.mjs`

`pnpm test:e2e:matrix` is the composition root for whole-product verification:
provider simulator → real RouteKit daemon and gateway → door profiles and
real coding-agent CLIs where installed. See
[RouteKit end-to-end verification matrix](routekit-e2e-matrix.md) for filters,
live mode (`ROUTEKIT_LIVE_E2E=1`), and L06 qualification.

## The test pyramid, by layer

| Layer | What runs for real | What is simulated | Where |
|---|---|---|---|
| Unit / component | one module | everything around it | `packages/*/src/test`, root `test/` |
| Gateway adapters | dialect translation, SSE codecs, validation | provider upstream | `packages/gateway/src/test/` |
| Daemon / control | singleton lifecycle, config generations, call store | provider upstream | `packages/daemon/src/test/`, `packages/cli/src/test/` |
| Door matrix | door × behavior through daemon + gateway | provider | `packages/testkit/src/test/`, `scripts/routekit-e2e-matrix.mjs` |
| Real RouteKit CLI | built `routekit` entrypoint, lifecycle, doctor, install | provider only | `packages/cli/src/test/*process-e2e.test.js` |
| Real-CLI e2e | actual `claude` / `codex` / `opencode` binaries | provider only | matrix CLI cases |
| Live (env-gated) | everything incl. real provider accounts | nothing | `ROUTEKIT_LIVE_E2E=1` matrix mode |

Provider-wire and cost-accounting coverage lives in the TypeScript RouteKit
gateway and accounts suites.

**Surface coverage** at the E2E layer includes `/v1/chat/completions` (JSON +
SSE), `/v1/messages` (+ streaming, + `count_tokens`), `/v1/responses` (JSON +
SSE), `/v1/cursor/chat/completions`, model discovery routes, and subscription
pool failover cases.

## Running

```bash
# Node: everything
pnpm build && pnpm test

# Credential-free E2E matrix (self-skips without simulator checkout)
pnpm test:e2e:matrix

# Focused package tests after build
PORTLESS=0 node --test packages/gateway/dist/test/*.test.js
PORTLESS=0 node --test packages/cli/dist/test/*.test.js
```

CI runs repository checks, builds, unit tests, and the E2E matrix in
`.github/workflows/ci.yml`.

## Writing new tests — rules of thumb

1. **Default to the provider simulator, not an inline mock.** If a test needs
   "a provider", use `startProviderSim()`; ad-hoc `createServer` mocks should be
   rare (for example asserting behavior on a malformed upstream response).
2. **Assert on the journal.** The strongest assertion is what crossed the wire:
   which models were called, in what order, with which messages/tools, how many
   attempts.
3. **Pick the lowest layer that can falsify your change**, and add one test at
   the highest affected layer. A new gateway dialect is both a gateway unit test
   and a door-matrix case.
4. **Keep suites self-skipping, not environment-assuming.** Cross-stack tests
   gate on `detectStackTooling()`; live-provider tests stay behind
   `ROUTEKIT_LIVE_E2E=1`.

## Known gaps (environment- or platform-gated)

- Cursor's custom OpenAI endpoint is covered at the gateway door
  (`/v1/cursor/chat/completions` request translation and model advertising),
  but the editor side is manual: RouteKit does not launch Cursor, so no
  automated test observes a real Agent turn reaching the door.
- Real billed provider-account behavior (provider-side schema drift, actual
  rate limits, quality) remains in the explicitly env-gated live matrix mode.
- OpenCode has no first-class panel harness in RouteKit; only its real
  tool-facing CLI is exercised in the matrix when installed.
