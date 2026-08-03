# RouteKit routes, billing, and provider disclosures

Audience: maintainers reviewing RouteKit's launch support contract. This is the
canonical detailed disclosure for route qualification and evidence. Public
onboarding summarizes the relevant privacy, routing, and configuration
boundaries without exposing this maintainer evidence inventory.

The current first-launch contract contains six routes, all **Planned Supported
until L06 closes**. The 2026-07-22
[real-account report](evidence/routekit-real-account/2026-07-22-dad16c53.md)
records three API-route Pass results and four subscription/client Fail results
across the then-current seven rows at `@velum-labs/routekit` 0.8.0 revision
[`dad16c53`](https://github.com/velum-labs/routekit/commit/dad16c53c0e083a51d41df59149a21964d27cc12).
The Fail rows must be rerun with the required accounts and clients before the
public labels can change. That report predates ENG-700 and retains historical
Cursor rows; it is an immutable record of what was observed at that revision,
not a current support claim. Cursor Desktop 3.12.30 subsequently failed its
2026-08-01 custom-endpoint qualification and is not offered. The current exact
client builds and separate failure evidence are recorded in the
[client compatibility contract](routekit-supported-clients.md).

## Shared contract

- A requested namespaced model never falls through to another provider.
  Unknown routes fail; an explicit `defaultModel` applies only when a client
  omits the model.
- API routes have no RouteKit account-pool or cross-provider failover.
- Subscription pools rotate only among eligible accounts of the same kind.
  Exhaustion never switches to an API-key provider.
- Client-side panel expansion or custom retry policies are not RouteKit route
  fallbacks.
- RouteKit never claims unlimited use. Provider terms, plan limits, fair-use
  controls, quotas, and model availability always apply.

<a id="route-openai-api"></a>

## OpenAI API

- **Credential / owner:** User-owned `OPENAI_API_KEY`; optional explicit
  `OPENAI_BASE_URL`. Inline router-YAML keys are rejected.
- **Billing / egress:** API-key route, separate from the Codex subscription
  route, direct to `api.openai.com` unless the operator overrides the
  destination. OpenAI determines charges; exact attribution remains an L06
  check. No aggregator.
- **Quota / fallback:** Provider errors return to the caller; no account pool
  and no silent cross-provider fallback.
- **Protocol / limitations:** OpenAI Chat Completions and native Responses.
  Direct OpenAI API routes keep `/v1/responses` requests on the native Responses
  endpoint, preserving tools, reasoning, streaming, continuation IDs, and opaque
  response items without translating through Chat Completions. Model-specific
  reasoning and images depend on OpenAI. No provider-session restore.
- **Evidence:** **L06 qualification Pass** for `openai/gpt-5.5`, RouteKit 0.8.0
  / `dad16c53` / 2026-07-22. One real-account request was observed; tools,
  streaming, reasoning, cancellation, failure propagation, and no RouteKit
  fallback passed. Public status stays Planned until L06 closes. [Stable L05 mapping; canonical import pending
  evidence](routekit-l06-evidence.md#route-openai-api).

<a id="route-anthropic-api"></a>

## Anthropic API

- **Credential / owner:** User-owned `ANTHROPIC_API_KEY`; optional explicit
  `ANTHROPIC_BASE_URL`. RouteKit does not currently use
  `ANTHROPIC_AUTH_TOKEN` for provider requests.
- **Billing / egress:** API-key route, separate from the Claude Code
  subscription route, direct to `api.anthropic.com` by default. Anthropic
  determines charges; exact attribution remains an L06 check. No aggregator.
- **Quota / fallback:** Provider errors return to the caller; no account pool
  and no silent cross-provider fallback.
- **Protocol / limitations:** Native Messages with streaming, tools, thinking,
  signatures, and redacted-thinking where supported. Cross-dialect translation
  can preserve only shared fields. No provider-session restore.
- **Evidence:** **L06 qualification Pass** for
  `anthropic/claude-sonnet-4-6`, RouteKit 0.8.0 / `dad16c53` / 2026-07-22.
  One real-account request was observed; tools, streaming, reasoning,
  cancellation, failure propagation, and no RouteKit fallback passed. Public
  status stays Planned until L06 closes. [Stable L05 mapping; canonical import pending
  evidence](routekit-l06-evidence.md#route-anthropic-api).

<a id="route-bedrock-api"></a>

## Amazon Bedrock

- **Credential / owner:** Operator-owned AWS SDK default-chain identity and
  region; no static `AWS_ACCESS_KEY_ID` is required. Profile, SSO, role, web
  identity, container, and instance credentials remain governed by AWS. See
  the [AWS Bedrock setup runbook](aws-bedrock-setup.md).
- **Billing / egress:** Direct AWS Bedrock Runtime route in the configured
  account and region. AWS determines on-demand/provisioned, Marketplace,
  cross-region, and model charges; credits are account-specific. No aggregator,
  though cross-region inference profiles can route to AWS destination regions.
- **Quota / fallback:** AWS model access, IAM, service quotas, and throttling
  apply. Provider errors return to the caller; RouteKit does not silently
  switch providers.
- **Protocol / limitations:** Live model and inference-profile discovery plus
  Bedrock Runtime invocation. Availability, streaming, tools, reasoning, and
  required profile use vary by model and region.
- **Evidence:** **Pending authorized-operator qualification**, RouteKit 0.8.0 /
  2026-07-22. No live AWS account, region, credits, billing event, model
  invocation, or authenticated client run was observed for ENG-704
  documentation. Record the runbook checklist before making a support or
  billing-attribution claim.
  [Stable L05 mapping; canonical import pending
  evidence](routekit-l06-evidence.md#route-bedrock-api).

<a id="route-openrouter-api"></a>

## OpenRouter API

- **Credential / owner:** User-owned `OPENROUTER_API_KEY`.
- **Billing / egress:** OpenRouter API-key/credit route, not a native
  subscription route. OpenRouter determines charges and credit usage; exact
  attribution remains an L06 check. **OpenRouter is an aggregator:** RouteKit
  sends request content to `openrouter.ai`, which sends it to an upstream
  provider under OpenRouter routing. A model slug does not guarantee one
  upstream host. RouteKit supplies attribution headers.
- **Quota / fallback:** No RouteKit account pool or silent direct-provider
  switch. OpenRouter's own upstream routing remains governed by the user's
  OpenRouter settings and terms.
- **Protocol / limitations:** OpenAI Chat Completions; tools, streaming, images,
  context, and reasoning depend on OpenRouter and the upstream model. No
  provider-session restore.
- **Evidence:** **L06 qualification Pass** for
  `openrouter/openai/gpt-4o-mini`, RouteKit 0.8.0 / `dad16c53` / 2026-07-22.
  One real-account request was observed; tools, streaming, reasoning,
  cancellation, failure propagation, and no RouteKit fallback passed.
  OpenRouter remains the upstream-routing aggregator. Public status stays
  Planned until L06 closes. [Stable L05 mapping; canonical import pending
  evidence](routekit-l06-evidence.md#route-openrouter-api).

<a id="route-codex-subscription"></a>

## Codex subscription

- **Credential / owner:** User-owned Codex OAuth credential enrolled with
  `accounts login codex` or imported with `accounts add`; stored under
  `~/.routekit/subscriptions/codex/`.
- **Billing / egress:** Uses the enrolled subscription OAuth credential, never
  `OPENAI_API_KEY`, and relays directly to `chatgpt.com/backend-api/codex`.
  The provider determines plan usage and charges; exact attribution remains an
  L06 check. No third-party aggregator.
- **Quota / fallback:** Quota can rotate eligible Codex accounts. Transient
  retry is bounded to one same-account retry and one alternate. Exhaustion is
  explicit and never invokes a paid OpenAI API-key route.
- **Protocol / limitations:** OpenAI Responses with streaming, tools, and
  discovered reasoning efforts. Official client catalog/profile compatibility
  is version-sensitive; setup and restore remain pending L06. The exact
  supported Codex CLI build is `0.146.0`; see the
  [client compatibility contract](routekit-supported-clients.md).
- **Evidence:** **L06 qualification Fail — `account-unavailable`**, RouteKit 0.8.0
  / `dad16c53` / 2026-07-22. The worker had no enrolled Codex account or
  Codex client, so live streaming, billing attribution, setup, and restore were
  not observed. Deterministic tools, reasoning, cancellation, failure
  propagation, and zero API-key fallback passed. [Stable L05 mapping; canonical import pending
  evidence](routekit-l06-evidence.md#route-codex-subscription).

<a id="route-claude-code-subscription"></a>

## Claude Code subscription

- **Credential / owner:** User-owned Claude Code OAuth credential enrolled
  with `accounts login claude-code` or imported with `accounts add`; stored
  under `~/.routekit/subscriptions/claude-code/`.
- **Billing / egress:** Uses the enrolled subscription OAuth credential, never
  `ANTHROPIC_API_KEY`, and relays directly to Anthropic. Anthropic determines
  plan usage and charges; exact attribution remains an L06 check. No
  third-party aggregator.
- **Quota / fallback:** Same-kind eligible-account rotation with bounded
  transient retry. Exhaustion is explicit and never invokes a paid Anthropic
  API-key route.
- **Protocol / limitations:** The native Anthropic Messages relay forwards the
  client's body. The OpenAI-compatible subscription backend inserts the Claude
  Code identity and rewrites other caller `system` and `developer` messages as
  `user` messages. Streaming, tools, and thinking are supported. Managed
  install/uninstall, exact settings restore, last-account removal, and
  interruption recovery passed the credential-free
  [ENG-682 qualification](routekit-claude-recovery-evidence.md). The exact
  supported Claude Code builds are `2.1.216` and `2.1.220`; see the
  [client compatibility contract](routekit-supported-clients.md).
- **Evidence:** **L06 qualification Fail — `account-unavailable`**, RouteKit 0.8.0
  / `dad16c53` / 2026-07-22. The worker had no enrolled Claude Code
  account or Claude client, so live streaming, billing attribution, and
  real-account/provider-session setup and restore were not observed. The
  credential-free managed lifecycle passed separately at `4e5a45b9`.
  Deterministic tools, reasoning, cancellation, failure propagation, and zero
  API-key fallback passed. [Stable L05 mapping; canonical import pending
  evidence](routekit-l06-evidence.md#route-claude-code-subscription).

## Route explanation

`routekit models info <provider/model>` reports the live route's namespaced and
native model IDs, provider, account class, billing mode, default status,
capabilities, and reasoning metadata. API-key routes are classified as
`api-key` / `metered-api`; managed Codex and Claude Code routes as
`subscription` / `subscription`; and retained proxy routes as `proxy` /
`upstream-managed`. Unknown models fail and the response contract excludes
credentials, account labels, credential paths, and environment values.

The automated and zero-billed matrix evidence is recorded in
[RouteKit route explanation evidence](routekit-route-info-evidence.md).

## Not offered client surfaces

Cursor Desktop is not part of the current launch contract. On 2026-08-01,
Cursor Desktop 3.12.30 accepted temporary custom model entries but rejected
both RouteKit's canonical and retained legacy model spellings before sending a
gateway request. See the sanitized
[Cursor qualification record](evidence/client-compatibility/2026-08-01-cursor-3.12.30.md).
The retained `/v1/cursor` adapter is an internal compatibility surface, not a
support declaration. `cursor-agent` is also not offered because it expects
Cursor's backend/ACP protocol rather than an OpenAI-compatible gateway.

## Qualification requirement

The deterministic harness is documented in
[RouteKit end-to-end verification matrix](routekit-e2e-matrix.md). The
[sanitized L06 report](evidence/routekit-real-account/2026-07-22-dad16c53.md)
maps the route set that existed on 2026-07-22 to exact RouteKit revision,
credential mode, client/provider version, evidence date, protocol behavior,
billing attribution, failure behavior, and setup/restore results. Three of the
six current rows are Fail, so all public labels stay conditional.
The generated stable-map rows remain `pending` because this historical run
predates the mapping digest and case IDs; they do not override the immutable
ENG-679 report. Its historical Cursor row remains evidence-only and is not a
current route. A legacy importer must not fabricate modern case identities.
