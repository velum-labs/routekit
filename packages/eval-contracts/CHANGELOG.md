# @velum-labs/routekit-eval-contracts

## 1.0.5

## 1.0.4

## 1.0.3

## 1.0.2

## 1.0.1

## 1.0.0

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

### Patch Changes

- abd64a0: Migrate RouteKit internals onto Effect with a process-lifetime ManagedRuntime (`RouteKitLive`), tagged failures, FileSystem-backed document persistence, Effect `CapacityPool` leases, HttpClient egress, HttpRouter+NodeHttpServer inbound (drain/SSE/NDJSON wire unchanged), Effect account coordinators, account-set construction/probe/discover/close, subscription providers, proxy client, native Effect `control.v2` handlers (Promise only at the NDJSON wire), Effect reset-credit and auth-recovery programs, CLI catalog/health probes, cliproxy sidecar reachability, control-client health/call/stream as Effect (Promise only at Commander/host/NDJSON iterator edges), remaining CLI install/relay/handshake plus daemon shared-gateway probes as Effect, switching-proxy, endpoint/runtime health probes, ACP registry fetch/install, gateway web-search execution (one Effect per server-tool step on the HttpClient captured when the gateway HTTP app is built), OpenRouter metadata (single-flight Effect, not a nested runtime), provider HTTP transports on the inbound fiber, subscription execute/relays, daemon lifecycle/generations/sidecar/host-worker cores, daemon account enroll/remove/rename/sync plus subscription SSE inspect, subscription usage collection, local usage sources, `startSubscriptionProxy`, gateway-generation usage, relay close, CLI use-cases (accounts login/activate, config import, native install/uninstall, setup, remote enroll/remove/provision), remote enrollment/recovery transaction machines, provider model discovery plus `RoutingBackend.create`, host generation stages as Effect programs, and account-set/activity/auth-health/relay/executor Promise edges on captured fiber context via `runRouteKitEffectWith` instead of a nested ManagedRuntime. `Backend.chat`/`models`/`embeddings` (and `BackendResponsesPort.execute`) are `BackendRequest` Effects requiring `RouteKitPlatform`. Inbound `GatewayEndpoint.handle`/`executeOperation` stay on that captured fiber (`serveEndpoint` provides the platform). Server-tool `runStep` is Effect; `composeServerToolStream` runs `runRouteKitEffect*` only at ReadableStream start. Anthropic/Codex subscription relays are Effects. Account-set usage probes use `Deferred` plus a detached probe fiber (interrupted on close); activity persist debounce is a detached fiber woken from `beginAttempt`; gateway `usage` and `RelayLifecycle.close` are Effects (Node bind/close still Promise); daemon generation `persist` and `replaceRouter` are Effects so enroll/mutation no longer `runRouteKitEffectWith` inside persist hooks; post-handoff subscription stream observe work is queued onto a detached fiber instead of `runRouteKitEffectWith`; CLI `launchTool`/`resolveCodexLaunchSelection` are Effects (`runCliEffect` at Commander, spawn still Promise); `routekitClient`/`connectDaemon` are lazy Effect values. Promise remains at Commander, NDJSON, Node bind, Fetch body reads, SSE stream controllers, and `[Symbol.asyncDispose]`. `cliTry`/`controlTry`/`gatewayTry` tag failures as `RouteKitFailure`; `routeKitError` still unwraps wrap-only `RouteKitFailure` so Error subclasses map on the wire. OpenRouter metadata refresh uses Effect timeout (not unref'd `AbortSignal.timeout`) so hanging fetches still settle. CLI `routekitClient`/`ensureDaemon`/`connectDaemon` are Effect programs (`runCliEffect` only at Commander) and fail with tagged `RouteKitFailure` so Effect tsgo `globalErrorInEffectFailure` stays at 0 errors. `runRouteKitEffect`/`runCliEffect` do not constrain `R` to `RouteKitPlatform` so programs that `yield*` HttpClient (Effect 4 `Request<"Requires", _>`) typecheck at the process edge. Drop wrap-only Effect façades and unused `runBackendRequest`. Schema eval contracts and Effect language-service diagnostics (`globalErrorInEffectFailure`, `globalErrorInEffectCatch`, and `tryCatchInEffectGen` as error; `globalFetch` stays off for tests and the live Fetch adapter, with `globalFetchInEffect` already error). Product wire (control.v2, HTTP/SSE, CLI output, persisted formats) stays unchanged. Domain coordinators are wrapped behind Effect 4 `Context.Service` keys (`AccountActivity`, `AccountAuth`, `DaemonEnv`/`DaemonState`/`Sidecar`/`Generations`/`ActiveGateway`/`Tokens`/`Telemetry`/`DataPlane`/`AccountRecovery`/`CallAttributions`/`Leaderboard`/`DaemonPolicy`/`DaemonHost`, CLI `DaemonClient` via `CliLive`) composed as `daemonLive` so control handlers `yield*` services; CLI Commander actions run one program via `runCliClient` or one `runCliEffect` per action. Service-facing coordinator types expose only public operations (with direct Effect semantics for zero-argument work), so Effect diagnostics are 0 errors, 0 warnings, and 0 messages. Telemetry mutations use `serializeEffect`; Promise `serializeMutation` is gone. `EffectResourceScope.own` prefers an Effect-returning `close()`; Promise finalizers are only the Node listen/close adapter. Gateway-generation and subscription-proxy `close` use `runRouteKitEffect` (no `runPromiseWith`). Activity/auth/account-set `[Symbol.asyncDispose]` uses `runRouteKitEffect`. `DaemonEnv` carries generation/startedAt/hosted; `ActiveGateway` holds the live router, switching proxy, data URL, and control server. Generation replace scopes an unpublished candidate with `Effect.addFinalizer` and adopts it after `swapTarget`. `waitForServiceReadyEffect` and `waitForProcessExitEffect` are the readiness/exit pollers; the Promise wrappers are process-edge adapters. CLI service install/uninstall/status, config init/edit, daemon exec, and `usage --watch` are one Commander program each (`watchUsageEffect` ticks on the same fiber). Inbound `serveEndpoint` provides the `RouteKitPlatform` captured when the gateway HTTP app is built (HttpClient included), so relays and provider backends no longer store or `provideCapturedPlatform`. Daemon bootstrap is one Effect program (`runRouteKitEffect` once; Node listen via `tryPromise`; Promise only on returned close/retire/reload). `runCapturedPlatform` is a test helper, not a public export.

  Provider resources, backend ownership, gateway drain/close, router close, subscription-proxy close, relay teardown, and Node HTTP handler teardown are Effect values. `startGatewayEffect` is the internal constructor; the Promise `startGateway` function is only the standalone Node host adapter. Captured request platform contexts omit the construction scope so a router generation can publish a handler beyond its prepare scope without retaining or closing that scope.

  The switching proxy and control listener now expose Effect construction, idle waits, retirement, drain, and close; daemon bootstrap consumes those Effects directly. Endpoint pipeline stages, Anthropic catalog merging, account acquisition revalidation, and auth-recovery waiters are Effect-native, with `Deferred` replacing Promise coordination. Promise adapters remain only where Node, Commander, Fetch/Web Streams, AsyncDisposable, cluster IPC, or standalone public hosts require them.
