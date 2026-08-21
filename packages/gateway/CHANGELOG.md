# @velum-labs/routekit-gateway

## 1.0.21

### Patch Changes

- @velum-labs/routekit-config-core@1.0.21
- @velum-labs/routekit-contracts@1.0.21
- @velum-labs/routekit-eval-contracts@1.0.21
- @velum-labs/routekit-eval-core@1.0.21
- @velum-labs/routekit-registry@1.0.21
- @velum-labs/routekit-runtime@1.0.21

## 1.0.20

### Patch Changes

- @velum-labs/routekit-config-core@1.0.20
- @velum-labs/routekit-contracts@1.0.20
- @velum-labs/routekit-eval-contracts@1.0.20
- @velum-labs/routekit-eval-core@1.0.20
- @velum-labs/routekit-registry@1.0.20
- @velum-labs/routekit-runtime@1.0.20

## 1.0.19

### Patch Changes

- 3235153: Keep credential-load and per-account model-discovery failures visible in daemon
  logs while allowing unavailable or empty Codex and Claude subscription catalogs
  to coexist with healthy configured providers.
  - @velum-labs/routekit-config-core@1.0.19
  - @velum-labs/routekit-contracts@1.0.19
  - @velum-labs/routekit-eval-contracts@1.0.19
  - @velum-labs/routekit-eval-core@1.0.19
  - @velum-labs/routekit-registry@1.0.19
  - @velum-labs/routekit-runtime@1.0.19

## 1.0.18

### Patch Changes

- @velum-labs/routekit-config-core@1.0.18
- @velum-labs/routekit-contracts@1.0.18
- @velum-labs/routekit-eval-contracts@1.0.18
- @velum-labs/routekit-eval-core@1.0.18
- @velum-labs/routekit-registry@1.0.18
- @velum-labs/routekit-runtime@1.0.18

## 1.0.17

### Patch Changes

- @velum-labs/routekit-config-core@1.0.17
- @velum-labs/routekit-contracts@1.0.17
- @velum-labs/routekit-eval-contracts@1.0.17
- @velum-labs/routekit-eval-core@1.0.17
- @velum-labs/routekit-registry@1.0.17
- @velum-labs/routekit-runtime@1.0.17

## 1.0.16

### Patch Changes

- @velum-labs/routekit-config-core@1.0.16
- @velum-labs/routekit-contracts@1.0.16
- @velum-labs/routekit-eval-contracts@1.0.16
- @velum-labs/routekit-eval-core@1.0.16
- @velum-labs/routekit-registry@1.0.16
- @velum-labs/routekit-runtime@1.0.16

## 1.0.15

### Patch Changes

- @velum-labs/routekit-config-core@1.0.15
- @velum-labs/routekit-contracts@1.0.15
- @velum-labs/routekit-eval-contracts@1.0.15
- @velum-labs/routekit-eval-core@1.0.15
- @velum-labs/routekit-registry@1.0.15
- @velum-labs/routekit-runtime@1.0.15

## 1.0.14

### Patch Changes

- @velum-labs/routekit-config-core@1.0.14
- @velum-labs/routekit-contracts@1.0.14
- @velum-labs/routekit-eval-contracts@1.0.14
- @velum-labs/routekit-eval-core@1.0.14
- @velum-labs/routekit-registry@1.0.14
- @velum-labs/routekit-runtime@1.0.14

## 1.0.13

### Patch Changes

- @velum-labs/routekit-config-core@1.0.13
- @velum-labs/routekit-contracts@1.0.13
- @velum-labs/routekit-eval-contracts@1.0.13
- @velum-labs/routekit-eval-core@1.0.13
- @velum-labs/routekit-registry@1.0.13
- @velum-labs/routekit-runtime@1.0.13

## 1.0.12

### Patch Changes

- @velum-labs/routekit-config-core@1.0.12
- @velum-labs/routekit-contracts@1.0.12
- @velum-labs/routekit-eval-contracts@1.0.12
- @velum-labs/routekit-eval-core@1.0.12
- @velum-labs/routekit-registry@1.0.12
- @velum-labs/routekit-runtime@1.0.12

## 1.0.11

### Patch Changes

- Updated dependencies [a148a71]
  - @velum-labs/routekit-runtime@1.0.11
  - @velum-labs/routekit-eval-core@1.0.11
  - @velum-labs/routekit-config-core@1.0.11
  - @velum-labs/routekit-contracts@1.0.11
  - @velum-labs/routekit-eval-contracts@1.0.11
  - @velum-labs/routekit-registry@1.0.11

## 1.0.10

### Patch Changes

- 0a83607: Keep native OpenAI Responses SSE relays alive during quiet model phases and emit
  a structured terminal error when an upstream stream ends before a Responses
  terminal event.
- Updated dependencies [0a83607]
  - @velum-labs/routekit-runtime@1.0.10
  - @velum-labs/routekit-eval-core@1.0.10
  - @velum-labs/routekit-config-core@1.0.10
  - @velum-labs/routekit-contracts@1.0.10
  - @velum-labs/routekit-eval-contracts@1.0.10
  - @velum-labs/routekit-registry@1.0.10

## 1.0.9

### Patch Changes

- 0d4d984: Fix ENG-834 by increasing evaluation-authoring output headroom for twenty-case
  suites and reporting max-token Responses truncation as an incomplete, failed
  model call with its stop reason instead of an invalid-JSON authoring response.
  - @velum-labs/routekit-config-core@1.0.9
  - @velum-labs/routekit-contracts@1.0.9
  - @velum-labs/routekit-eval-contracts@1.0.9
  - @velum-labs/routekit-eval-core@1.0.9
  - @velum-labs/routekit-registry@1.0.9
  - @velum-labs/routekit-runtime@1.0.9

## 1.0.8

### Patch Changes

- 1d5f0e5: Sanitize unsupported Anthropic structured-output constraints at provider egress while retaining eval authoring bounds through post-parse validation.
  - @velum-labs/routekit-config-core@1.0.8
  - @velum-labs/routekit-contracts@1.0.8
  - @velum-labs/routekit-eval-contracts@1.0.8
  - @velum-labs/routekit-eval-core@1.0.8
  - @velum-labs/routekit-registry@1.0.8
  - @velum-labs/routekit-runtime@1.0.8

## 1.0.7

### Patch Changes

- 34d315f: Advertise only the verified GPT-5.6 family in the Amazon Bedrock OpenAI catalog and correct the Bedrock documentation.
  - @velum-labs/routekit-config-core@1.0.7
  - @velum-labs/routekit-contracts@1.0.7
  - @velum-labs/routekit-eval-contracts@1.0.7
  - @velum-labs/routekit-eval-core@1.0.7
  - @velum-labs/routekit-registry@1.0.7
  - @velum-labs/routekit-runtime@1.0.7

## 1.0.6

### Patch Changes

- 293ad25: Restore OpenAI GPT-5.6-family discovery and inference on Amazon Bedrock through the regional bedrock-mantle API.
  - @velum-labs/routekit-config-core@1.0.6
  - @velum-labs/routekit-contracts@1.0.6
  - @velum-labs/routekit-eval-contracts@1.0.6
  - @velum-labs/routekit-eval-core@1.0.6
  - @velum-labs/routekit-registry@1.0.6
  - @velum-labs/routekit-runtime@1.0.6

## 1.0.5

### Patch Changes

- @velum-labs/routekit-config-core@1.0.5
- @velum-labs/routekit-contracts@1.0.5
- @velum-labs/routekit-eval-contracts@1.0.5
- @velum-labs/routekit-eval-core@1.0.5
- @velum-labs/routekit-registry@1.0.5
- @velum-labs/routekit-runtime@1.0.5

## 1.0.4

### Patch Changes

- @velum-labs/routekit-config-core@1.0.4
- @velum-labs/routekit-contracts@1.0.4
- @velum-labs/routekit-eval-contracts@1.0.4
- @velum-labs/routekit-eval-core@1.0.4
- @velum-labs/routekit-registry@1.0.4
- @velum-labs/routekit-runtime@1.0.4

## 1.0.3

### Patch Changes

- 1a117e9: Forward Responses JSON schemas to Anthropic structured outputs and include bounded author output, parse diagnostics, and model call IDs when eval authoring returns invalid JSON.
  - @velum-labs/routekit-config-core@1.0.3
  - @velum-labs/routekit-contracts@1.0.3
  - @velum-labs/routekit-eval-contracts@1.0.3
  - @velum-labs/routekit-eval-core@1.0.3
  - @velum-labs/routekit-registry@1.0.3
  - @velum-labs/routekit-runtime@1.0.3

## 1.0.2

### Patch Changes

- 30956e3: Allow eval authoring models to choose compatible reasoning controls and include upstream error details plus the model call ID when authoring requests fail.
  - @velum-labs/routekit-config-core@1.0.2
  - @velum-labs/routekit-contracts@1.0.2
  - @velum-labs/routekit-eval-contracts@1.0.2
  - @velum-labs/routekit-eval-core@1.0.2
  - @velum-labs/routekit-registry@1.0.2
  - @velum-labs/routekit-runtime@1.0.2

## 1.0.1

### Patch Changes

- e8b810e: Translate legacy `max_tokens` to `max_completion_tokens` for GPT-5-family Chat Completions requests.
  - @velum-labs/routekit-config-core@1.0.1
  - @velum-labs/routekit-contracts@1.0.1
  - @velum-labs/routekit-eval-contracts@1.0.1
  - @velum-labs/routekit-eval-core@1.0.1
  - @velum-labs/routekit-registry@1.0.1
  - @velum-labs/routekit-runtime@1.0.1

## 1.0.0

### Major Changes

- 79fe1c7: Remove retired compatibility surfaces and introduce explicit resource ownership,
  transactional router generations and remote enrollment, and cancellation-safe
  harness sessions. Move router configuration ownership into config-core, add
  validated provider boundary codecs and streaming, decompose routing and HTTP
  endpoints into explicit ports, make daemon/CLI application services declarative,
  and enforce intentional package APIs in CI.

### Minor Changes

- 0e67bb3: Introduce the sole compositional eval-routing protocol, repository-scoped review artifacts and immutable plans, bounded eval sessions, atomic routing activation, and the public `routekit eval` workflow.
- 3e3effd: Add compositional eval routing as RouteKit's sole automatic-routing protocol.
  A model-blind classifier decomposes each request across a reviewed routing
  basis, while deterministic code combines that decomposition with hard request
  requirements, complete model-by-dimension evidence, and the user's quality,
  cost, latency, balanced, or Pareto objective.

  Expose the complete durable workflow through `routekit eval`: repository setup,
  one-question-at-a-time onboarding, workload-dimension and evaluation proposals,
  digest-bound review approvals, validation, immutable planning and estimates,
  scoped qualification runs, structured results, and atomic routing activation.
  Normal billed work uses RouteKit's configured local or remote target; explicit
  external gateways may qualify evidence but cannot activate it.

  Require complete manifest-bound comparison evidence, stable case identities,
  strict normalized request decompositions, conservative quality measurements,
  explicit unknown pricing, sanitized provenance, and fail-closed routing. Add
  scoped eval sessions with explicit model and output limits, atomic project and
  activation artifacts, and interruption-safe cleanup and reporting.

- 59c83e0: Accept tightly mapped, short-lived ES256 workload credentials alongside durable RouteKit data tokens. Daemons can load a nonsecret public-key authorization policy while brokered credentials remain memory-only.

### Patch Changes

- cf49bbd: Split the Anthropic Messages adapter into wire types, JSON/SSE codecs, Claude picker policy, and HTTP handlers so translation can change without dragging the server path with it.
- 909aec9: Split Anthropic Messages request/response/stream translation out of the provider backend so wire changes do not drag HTTP transport with them.
- 17e297a: Split Bedrock Converse request/response/stream translation out of the provider source so wire changes do not drag model discovery and transport with them.
- d7678cf: Split Codex Responses request/response/stream translation out of the provider backend so wire changes do not drag HTTP transport with them.
- dffa147: Move configuredProviderIds onto config-core so the gateway catalog and the config package cannot disagree about which providers are enabled or in what order.
- abd64a0: Migrate RouteKit internals onto Effect with a process-lifetime ManagedRuntime (`RouteKitLive`), tagged failures, FileSystem-backed document persistence, Effect `CapacityPool` leases, HttpClient egress, HttpRouter+NodeHttpServer inbound (drain/SSE/NDJSON wire unchanged), Effect account coordinators, account-set construction/probe/discover/close, subscription providers, proxy client, native Effect `control.v2` handlers (Promise only at the NDJSON wire), Effect reset-credit and auth-recovery programs, CLI catalog/health probes, cliproxy sidecar reachability, control-client health/call/stream as Effect (Promise only at Commander/host/NDJSON iterator edges), remaining CLI install/relay/handshake plus daemon shared-gateway probes as Effect, switching-proxy, endpoint/runtime health probes, ACP registry fetch/install, gateway web-search execution (one Effect per server-tool step on the HttpClient captured when the gateway HTTP app is built), OpenRouter metadata (single-flight Effect, not a nested runtime), provider HTTP transports on the inbound fiber, subscription execute/relays, daemon lifecycle/generations/sidecar/host-worker cores, daemon account enroll/remove/rename/sync plus subscription SSE inspect, subscription usage collection, local usage sources, `startSubscriptionProxy`, gateway-generation usage, relay close, CLI use-cases (accounts login/activate, config import, native install/uninstall, setup, remote enroll/remove/provision), remote enrollment/recovery transaction machines, provider model discovery plus `RoutingBackend.create`, host generation stages as Effect programs, and account-set/activity/auth-health/relay/executor Promise edges on captured fiber context via `runRouteKitEffectWith` instead of a nested ManagedRuntime. `Backend.chat`/`models`/`embeddings` (and `BackendResponsesPort.execute`) are `BackendRequest` Effects requiring `RouteKitPlatform`. Inbound `GatewayEndpoint.handle`/`executeOperation` stay on that captured fiber (`serveEndpoint` provides the platform). Server-tool `runStep` is Effect; `composeServerToolStream` runs `runRouteKitEffect*` only at ReadableStream start. Anthropic/Codex subscription relays are Effects. Account-set usage probes use `Deferred` plus a detached probe fiber (interrupted on close); activity persist debounce is a detached fiber woken from `beginAttempt`; gateway `usage` and `RelayLifecycle.close` are Effects (Node bind/close still Promise); daemon generation `persist` and `replaceRouter` are Effects so enroll/mutation no longer `runRouteKitEffectWith` inside persist hooks; post-handoff subscription stream observe work is queued onto a detached fiber instead of `runRouteKitEffectWith`; CLI `launchTool`/`resolveCodexLaunchSelection` are Effects (`runCliEffect` at Commander, spawn still Promise); `routekitClient`/`connectDaemon` are lazy Effect values. Promise remains at Commander, NDJSON, Node bind, Fetch body reads, SSE stream controllers, and `[Symbol.asyncDispose]`. `cliTry`/`controlTry`/`gatewayTry` tag failures as `RouteKitFailure`; `routeKitError` still unwraps wrap-only `RouteKitFailure` so Error subclasses map on the wire. OpenRouter metadata refresh uses Effect timeout (not unref'd `AbortSignal.timeout`) so hanging fetches still settle. CLI `routekitClient`/`ensureDaemon`/`connectDaemon` are Effect programs (`runCliEffect` only at Commander) and fail with tagged `RouteKitFailure` so Effect tsgo `globalErrorInEffectFailure` stays at 0 errors. `runRouteKitEffect`/`runCliEffect` do not constrain `R` to `RouteKitPlatform` so programs that `yield*` HttpClient (Effect 4 `Request<"Requires", _>`) typecheck at the process edge. Drop wrap-only Effect façades and unused `runBackendRequest`. Schema eval contracts and Effect language-service diagnostics (`globalErrorInEffectFailure`, `globalErrorInEffectCatch`, and `tryCatchInEffectGen` as error; `globalFetch` stays off for tests and the live Fetch adapter, with `globalFetchInEffect` already error). Product wire (control.v2, HTTP/SSE, CLI output, persisted formats) stays unchanged. Domain coordinators are wrapped behind Effect 4 `Context.Service` keys (`AccountActivity`, `AccountAuth`, `DaemonEnv`/`DaemonState`/`Sidecar`/`Generations`/`ActiveGateway`/`Tokens`/`Telemetry`/`DataPlane`/`AccountRecovery`/`CallAttributions`/`Leaderboard`/`DaemonPolicy`/`DaemonHost`, CLI `DaemonClient` via `CliLive`) composed as `daemonLive` so control handlers `yield*` services; CLI Commander actions run one program via `runCliClient` or one `runCliEffect` per action. Service-facing coordinator types expose only public operations (with direct Effect semantics for zero-argument work), so Effect diagnostics are 0 errors, 0 warnings, and 0 messages. Telemetry mutations use `serializeEffect`; Promise `serializeMutation` is gone. `EffectResourceScope.own` prefers an Effect-returning `close()`; Promise finalizers are only the Node listen/close adapter. Gateway-generation and subscription-proxy `close` use `runRouteKitEffect` (no `runPromiseWith`). Activity/auth/account-set `[Symbol.asyncDispose]` uses `runRouteKitEffect`. `DaemonEnv` carries generation/startedAt/hosted; `ActiveGateway` holds the live router, switching proxy, data URL, and control server. Generation replace scopes an unpublished candidate with `Effect.addFinalizer` and adopts it after `swapTarget`. `waitForServiceReadyEffect` and `waitForProcessExitEffect` are the readiness/exit pollers; the Promise wrappers are process-edge adapters. CLI service install/uninstall/status, config init/edit, daemon exec, and `usage --watch` are one Commander program each (`watchUsageEffect` ticks on the same fiber). Inbound `serveEndpoint` provides the `RouteKitPlatform` captured when the gateway HTTP app is built (HttpClient included), so relays and provider backends no longer store or `provideCapturedPlatform`. Daemon bootstrap is one Effect program (`runRouteKitEffect` once; Node listen via `tryPromise`; Promise only on returned close/retire/reload). `runCapturedPlatform` is a test helper, not a public export.

  Provider resources, backend ownership, gateway drain/close, router close, subscription-proxy close, relay teardown, and Node HTTP handler teardown are Effect values. `startGatewayEffect` is the internal constructor; the Promise `startGateway` function is only the standalone Node host adapter. Captured request platform contexts omit the construction scope so a router generation can publish a handler beyond its prepare scope without retaining or closing that scope.

  The switching proxy and control listener now expose Effect construction, idle waits, retirement, drain, and close; daemon bootstrap consumes those Effects directly. Endpoint pipeline stages, Anthropic catalog merging, account acquisition revalidation, and auth-recovery waiters are Effect-native, with `Deferred` replacing Promise coordination. Promise adapters remain only where Node, Commander, Fetch/Web Streams, AsyncDisposable, cluster IPC, or standalone public hosts require them.

- 661a99e: Organize application capabilities under shallow, explicitly owned service modules, separate platform and protocol adapters from services, add focused Runtime import surfaces, move gateway-generation composition into the daemon with native Effect scope ownership, and remove the obsolete standalone router package.
- 2d7c9de: Split Gemini generateContent request/response/stream translation out of the Google backend so wire changes do not drag HTTP transport with them.
- fed39e1: Move the OpenAI HTTP client out of the backend port module so every provider transport lives in its own file and port changes cannot drag Chat Completions / Responses egress with them.
- d235d33: Move verified OpenAI GPT-5.5 / GPT-5.6 reasoning controls onto the OpenAI provider source so catalog inference cannot drift from the source that owns the wire.
- a16adf1: Split the OpenAI Responses adapter into wire types, JSON codec, and HTTP handlers so translation can change without dragging the server path with it.
- c8c6a06: Move dialect-aware server-tool transcript writing out of the loop so Anthropic/Google/Responses lossless metadata can change without dragging search orchestration with it.
- Updated dependencies [79fe1c7]
- Updated dependencies [0e67bb3]
- Updated dependencies [dffa147]
- Updated dependencies [abd64a0]
- Updated dependencies [abe8938]
- Updated dependencies [661a99e]
- Updated dependencies [3e3effd]
  - @velum-labs/routekit-config-core@1.0.0
  - @velum-labs/routekit-contracts@1.0.0
  - @velum-labs/routekit-registry@1.0.0
  - @velum-labs/routekit-runtime@1.0.0
  - @velum-labs/routekit-eval-contracts@1.0.0
  - @velum-labs/routekit-eval-core@1.0.0

## 0.18.2

### Patch Changes

- 55bf691: Add zero-downtime daemon worker restarts and upgrades behind a stable cluster
  host, including shared listener handoff, rollback-safe generation commits,
  worker/host status metadata, managed sidecar ownership, retirement draining,
  and rolling lifecycle telemetry.
- Updated dependencies [55bf691]
  - @velum-labs/routekit-runtime@0.18.2
  - @velum-labs/routekit-contracts@0.18.2
  - @velum-labs/routekit-registry@0.18.2
  - @velum-labs/routekit-tracing@0.18.2

## 0.18.1

### Patch Changes

- eb319e5: Discover Bedrock Opus 5 reasoning controls, translate selections to Bedrock
  Converse requests, and route profile-required foundation requests through an
  active inference profile.
- 88235cb: Keep OpenRouter metadata deadlines alive until pending requests settle so
  timeouts reliably reject instead of leaving unresolved model selection work.
  - @velum-labs/routekit-contracts@0.18.1
  - @velum-labs/routekit-registry@0.18.1
  - @velum-labs/routekit-runtime@0.18.1
  - @velum-labs/routekit-tracing@0.18.1

## 0.18.0

### Patch Changes

- 161c5c8: Fix ENG-737 by emitting OpenAI-compatible `tsc_` item IDs for translated
  `tool_search_call` responses so their history remains valid after a model switch.
- 0c1f18e: Repair legacy `ttc_` tool-search item IDs when replaying existing conversation
  history to native OpenAI Responses destinations.
  - @velum-labs/routekit-contracts@0.18.0
  - @velum-labs/routekit-registry@0.18.0
  - @velum-labs/routekit-runtime@0.18.0
  - @velum-labs/routekit-tracing@0.18.0

## 0.17.4

### Patch Changes

- d42282c: Add a persisted credential-authentication state machine for managed
  subscriptions. Coalesce refresh and probation, reroute pre-commit failures to
  healthy accounts, distinguish credential-, model-, and request-scoped denials,
  surface upstream authentication readiness, and map permanent rejection versus
  temporary recovery to actionable gateway errors.
- 065aeea: Allow Codex conversations to switch between Claude, chat-based providers, and
  native Responses providers without failing on incompatible encrypted reasoning.
  RouteKit now preserves opaque reasoning only for its originating provider and
  native model while keeping the portable conversation and tool history intact.
- Updated dependencies [d42282c]
  - @velum-labs/routekit-contracts@0.17.4
  - @velum-labs/routekit-registry@0.17.4
  - @velum-labs/routekit-runtime@0.17.4
  - @velum-labs/routekit-tracing@0.17.4

## 0.17.3

### Patch Changes

- @velum-labs/routekit-contracts@0.17.3
- @velum-labs/routekit-registry@0.17.3
- @velum-labs/routekit-runtime@0.17.3
- @velum-labs/routekit-tracing@0.17.3

## 0.17.2

### Patch Changes

- 854dd1c: Use Claude Code's native custom-model picker and effort selector instead of
  advertising synthetic `claude-*` and effort-qualified RouteKit models. Claude
  can now route an unambiguous bare provider-native model id.
  - @velum-labs/routekit-contracts@0.17.2
  - @velum-labs/routekit-registry@0.17.2
  - @velum-labs/routekit-runtime@0.17.2
  - @velum-labs/routekit-tracing@0.17.2

## 0.17.1

### Patch Changes

- @velum-labs/routekit-contracts@0.17.1
- @velum-labs/routekit-registry@0.17.1
- @velum-labs/routekit-runtime@0.17.1
- @velum-labs/routekit-tracing@0.17.1

## 0.17.0

### Patch Changes

- @velum-labs/routekit-contracts@0.17.0
- @velum-labs/routekit-registry@0.17.0
- @velum-labs/routekit-runtime@0.17.0
- @velum-labs/routekit-tracing@0.17.0

## 0.16.9

### Patch Changes

- @velum-labs/routekit-contracts@0.16.9
- @velum-labs/routekit-registry@0.16.9
- @velum-labs/routekit-runtime@0.16.9
- @velum-labs/routekit-tracing@0.16.9

## 0.16.8

### Patch Changes

- @velum-labs/routekit-contracts@0.16.8
- @velum-labs/routekit-registry@0.16.8
- @velum-labs/routekit-runtime@0.16.8
- @velum-labs/routekit-tracing@0.16.8

## 0.16.7

### Patch Changes

- eabcc38: Retry managed Codex subscription requests when forced upstream SSE reports a terminal quota failure before output, while preserving structured stream errors and holding account capacity through body completion.
  - @velum-labs/routekit-contracts@0.16.7
  - @velum-labs/routekit-registry@0.16.7
  - @velum-labs/routekit-runtime@0.16.7
  - @velum-labs/routekit-tracing@0.16.7

## 0.16.6

### Patch Changes

- @velum-labs/routekit-contracts@0.16.6
- @velum-labs/routekit-registry@0.16.6
- @velum-labs/routekit-runtime@0.16.6
- @velum-labs/routekit-tracing@0.16.6

## 0.16.5

### Patch Changes

- 448e004: Add shared reasoning-effort model variants for Claude Code and Cursor, and
  route validated `--effort` selections through every current launcher.

  Claude Code discovery now advertises `<base>:<effort>` picker entries from
  provider-discovered capabilities, normalizes them to the unsuffixed base model,
  and applies request-scoped adaptive thinking plus `output_config.effort` on
  both native relay and translated routes. Unsupported qualified ids fail before
  any provider call. Direct `routekit claude --effort` and `routekit cursor
--effort` no longer drop a validated selection.

- Updated dependencies [448e004]
  - @velum-labs/routekit-contracts@0.16.5
  - @velum-labs/routekit-registry@0.16.5
  - @velum-labs/routekit-runtime@0.16.5
  - @velum-labs/routekit-tracing@0.16.5

## 0.16.4

### Patch Changes

- 485132e: Normalize overlong OpenAI Responses tool call IDs during provider egress.
  - @velum-labs/routekit-contracts@0.16.4
  - @velum-labs/routekit-registry@0.16.4
  - @velum-labs/routekit-runtime@0.16.4
  - @velum-labs/routekit-tracing@0.16.4

## 0.16.3

### Patch Changes

- @velum-labs/routekit-contracts@0.16.3
- @velum-labs/routekit-registry@0.16.3
- @velum-labs/routekit-runtime@0.16.3
- @velum-labs/routekit-tracing@0.16.3

## 0.16.2

### Patch Changes

- @velum-labs/routekit-contracts@0.16.2
- @velum-labs/routekit-registry@0.16.2
- @velum-labs/routekit-runtime@0.16.2
- @velum-labs/routekit-tracing@0.16.2

## 0.16.1

### Patch Changes

- @velum-labs/routekit-contracts@0.16.1
- @velum-labs/routekit-registry@0.16.1
- @velum-labs/routekit-runtime@0.16.1
- @velum-labs/routekit-tracing@0.16.1

## 0.16.0

### Minor Changes

- 8185e03: Keep direct OpenAI API requests to `/v1/responses` on the native Responses
  endpoint so reasoning, function tools, streaming, and response items remain
  lossless.

### Patch Changes

- @velum-labs/routekit-contracts@0.16.0
- @velum-labs/routekit-registry@0.16.0
- @velum-labs/routekit-runtime@0.16.0
- @velum-labs/routekit-tracing@0.16.0

## 0.15.1

### Patch Changes

- b8023ac: Prevent streamd gateway responses from retaining close listeners during backpressure.
  - @velum-labs/routekit-contracts@0.15.1
  - @velum-labs/routekit-registry@0.15.1
  - @velum-labs/routekit-runtime@0.15.1
  - @velum-labs/routekit-tracing@0.15.1

## 0.15.0

### Minor Changes

- 5cd0e8c: improvements
- d81a841: Add strict model catalog allowlist and denylist policy with live-catalog enforcement and field-level SDK config layering.

### Patch Changes

- Updated dependencies [5cd0e8c]
  - @velum-labs/routekit-contracts@0.15.0
  - @velum-labs/routekit-registry@0.15.0
  - @velum-labs/routekit-runtime@0.15.0
  - @velum-labs/routekit-tracing@0.15.0
