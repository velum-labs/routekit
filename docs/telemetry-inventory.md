# Product telemetry inventory

## Purpose and consent

RouteKit product telemetry measures feature adoption and aggregate gateway reliability and usage so Velum can prioritize fixes and product work. It is **off by default** and requires explicit opt-in with `routekit telemetry on` or a truthy `ROUTEKIT_TELEMETRY` value. The daemon sends anonymous events to PostHog US (`https://us.i.posthog.com`) only when `ROUTEKIT_POSTHOG_KEY` is also configured; `ROUTEKIT_POSTHOG_HOST` may override the ingest host.

RouteKit creates a random anonymous install ID when telemetry is enabled. It does not identify PostHog persons, use feature flags or remote configuration, or enable exception autocapture. `routekit telemetry reset` rotates the local ID. Resetting or deleting `~/.routekit/telemetry.json` breaks future linkage, but deleting historical PostHog data requires contacting Velum because RouteKit exposes no historical-deletion API.

`DO_NOT_TRACK=1` (also `true`, `on`, or `yes`) always wins over file and `ROUTEKIT_TELEMETRY` settings. Consent and category state are resolved immediately before every capture. No PostHog client is created and no PostHog network request is made while telemetry is disabled, DNT is active, or the runtime key is missing. A disabled category never queues new events, and its unsent gateway summaries are discarded rather than retained for a later re-enable; the shared transport can still send events from categories that remain enabled.

## Controls

```sh
routekit telemetry status
routekit telemetry on
routekit telemetry off
routekit telemetry category usage on|off
routekit telemetry category reliability on|off
routekit telemetry category adoption on|off
routekit telemetry schema
routekit telemetry reset
```

Remote and peer-targeted CLI commands send command-completion telemetry to the daemon they actually contacted. That daemon's owner controls consent, destination, and anonymous install ID. Telemetry commands themselves, internal daemon/relay commands, completion, version, and self-update are not command events. Telemetry never starts a daemon solely to emit a command event.

## Exact event inventory

Every event also contains `schema_version`, `$process_person_profile: false`, and `$ip: null`.

### Usage

- `routekit.gateway_usage_summary`: `provider`, exact canonical `model`, `dialect`, `request_kind`, `stream`, `billing_mode`, `input_token_bucket`, `output_token_bucket`, `request_count_bucket`, `version`.

### Reliability

- `routekit.gateway_reliability_summary`: `provider`, exact canonical `model`, `dialect`, `request_kind`, `stream`, `outcome`, `latency_bucket`, `retry_bucket`, `failover`, `request_count_bucket`, `version`.
- `routekit.daemon_lifecycle`: `action`, `outcome`, `supervisor`, `version`.

### Adoption

- `routekit.command_completed`: normalized fixed-enum `command`, `cli_version`, `os`, `arch`, `node_major`, `duration_bucket`, `outcome`, `exit_kind`, `is_ci`, `target_kind`.
- `routekit.product_operation_completed`: fixed-enum `operation`, `outcome`, `duration_bucket`, `version`.
- `routekit.telemetry_preference_changed`: `action`, optional `category`, `enabled`, `source`, `version`.

Gateway calls are grouped in bounded daemon memory and normally flushed once per hour. Summaries use token, latency, retry, and request-count buckets; there is no per-call product analytics event. Category controls materially gate the corresponding usage and reliability payloads. A local group is retained if any currently permitted summary cannot be queued.

## Forbidden data

Product telemetry must never include prompts, messages, response bodies, request or response bodies, raw errors or stack traces, credentials, API keys, bearer or OAuth tokens, account/principal/install labels or IDs (except the anonymous PostHog distinct ID), remote names or URLs, filesystem paths, source code, working directories, CLI arguments/options, call/request/response hashes or IDs, exact token counts, exact costs, exact timestamps, or exact latency/retry/request counts. Canonical provider and model identifiers are the only approved route identifiers and appear only in gateway summaries.

## Separate local and operator data planes

Product telemetry is separate from local call attribution (`routekit calls inspect` and `routekit leaderboard`), which can retain local principal/account attribution and usage details under RouteKit's local retention settings. It is also separate from operator-configured OpenTelemetry/OTLP tracing. Enabling or disabling PostHog telemetry does not enable, disable, export, or alter either system.

## Review record

- Reviewer: pending maintainer approval
- Review date: pending
- Reviewed SHA: pending merge
- Tests/evidence: `pnpm verify`; daemon integration capture; real `posthog-node` local batch capture and opt-out queue-discard tests; adversarial sensitive-canary payload tests

This file is the durable telemetry inventory. ENG-649 must be updated only after merge.
