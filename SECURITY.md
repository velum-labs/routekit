# Security policy

## Supported versions

Security fixes land on `main` first and are released in the next
`@velum-labs/routekit` CLI release. The supported line is the latest published
RouteKit release and its matching `@velum-labs/routekit-*` workspace packages.

Older releases may receive a targeted fix only when maintainers decide the
upgrade path is not sufficient for an actively exploited or high-impact issue.
Do not rely on a fixed historical minor line for security support.

## Reporting a vulnerability

Report security issues privately through GitHub Security Advisories for this
repository. Do not open public issues for vulnerabilities, secrets, or
supply-chain concerns.

Include:

- affected package, file, command, or workflow;
- reproduction steps;
- impact and affected versions; and
- suggested fix, if known.

## Scope

In scope:

- the `routekit` CLI and its npm package, `@velum-labs/routekit`;
- the singleton daemon, local control listener, and authenticated data gateway;
- provider routing, subscription account routing, model discovery, retry,
  failover containment, and request attribution;
- credential enrollment, token storage, generated coding-tool configuration,
  and remote enrollment over SSH;
- the public installer, self-update flow, npm packages, release artifacts,
  GitHub Actions workflows, and documentation site; and
- shared `@velum-labs/routekit-*` packages that support those surfaces.

Out of scope:

- third-party providers, model vendors, coding tools, package managers, SSH
  servers, operating systems, and user-managed reverse proxies;
- local configuration or scripts that users write outside this repository; and
- retained internal adapters or compatibility code that is not documented as a
  current public RouteKit support surface.

## Data handling

RouteKit stores local configuration, daemon state, account metadata, and tokens
needed to operate the gateway. Provider API keys are read from environment
variables named by router configuration; inline router-YAML keys are rejected.
Subscription credentials are stored under the user-controlled `ROUTEKIT_HOME`
tree.

RouteKit does not claim to own native client transcript history, account-plan
limits, provider billing records, or upstream retention. Native clients and
providers keep their own history, deletion, quota, and billing behavior.

Telemetry is off by default and requires explicit opt-in. `DO_NOT_TRACK`
force-disables telemetry. See [Privacy and data handling](docs/telemetry-inventory.md)
for local retention, provider egress, OpenRouter disclosure, and rate-limit
failover behavior.

## Supply-chain posture

- npm and GitHub Actions dependencies are exact-pinned through the pnpm
  `catalog:` in `pnpm-workspace.yaml` and enforced by `scripts/check-repo.mjs`
  plus `syncpack lint`.
- `.npmrc` enables `engine-strict`, `ignore-scripts`, store-integrity
  verification, exact saves, and a minimum release age for new packages.
- Lockfiles are committed and CI installs with frozen lockfiles.
- npm publishing uses provenance and GitHub Actions OIDC.
- The public installer is uploaded to the versioned RouteKit CLI release and to
  the stable `routekit-latest` release channel. The release workflow downloads
  the documented installer URL and verifies that it returns a non-empty
  RouteKit installer.
