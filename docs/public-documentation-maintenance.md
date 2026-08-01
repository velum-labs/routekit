# Public documentation maintenance

Audience: maintainers changing RouteKit behavior or the public site under
`apps/docs`.

The public documentation is a product contract. Update it in the same change as
user-visible behavior, and derive claims from the sources below rather than from
an earlier documentation page.

## Source-of-truth matrix

| Product area | Product source | Public destination | Required validation |
| --- | --- | --- | --- |
| Installation and runtime requirements | `install.sh`, `shell/install.sh`, root `package.json` engines | `getting-started/installation.mdx`, landing quickstart | Installer tests, docs build |
| Commands, arguments, and flags | `packages/cli/src/commands`, built `routekit --help` | `reference/commands.mdx`, user-guide command tables | `docs-contract.test.ts` after CLI build |
| Router schema and defaults | `packages/gateway/src/router.ts`, `packages/config/src/index.ts` | `reference/configuration.mdx`, user guide | Gateway/config tests, docs build |
| Public providers and tools | `packages/cli/src/launch-support.ts`, tool registry | Installation, guides, routes and billing | Launch-support and docs-contract tests |
| Model IDs and capabilities | `spec/registry/model-catalog.json`, live discovery contracts | Model catalog, examples, landing | `scripts/docs/check-model-references.mjs` |
| Credentials, routing, billing, and egress | Provider registry, gateway/account contracts, L06 map | Routes and billing, privacy, provider guides | Evidence check and docs-contract tests |
| Subscription pool behavior | Accounts implementation and tests | Subscription pooling, user guide, commands | Accounts tests and docs-contract tests |
| Native Codex/Claude integration | CLI install commands and tool packages | User guide, commands, privacy, changelog | Native integration lifecycle tests |
| Remote operation | Remote commands, provisioner, SSH relay tests | Remote guide, user guide, commands | Remote tests and docs-contract tests |
| Release impact | Changesets and `packages/cli/CHANGELOG.md` | Public changelog | Current-version docs-contract check |

Root `docs/` files may contain deeper maintainer detail, but they are not a
substitute for checking implementation and tests. When public and maintainer
pages intentionally mirror a contract, update both in the same change.

## Change triggers

Review public documentation whenever a change touches any of these:

- a public command, argument, option, output state, or exit behavior;
- default configuration, a schema field, environment variable, or stored path;
- provider, model, coding-tool, endpoint, or protocol support;
- credential ownership, authentication, routing, retry, failover, quota, or
  billing behavior;
- installation, update, daemon supervision, remote provisioning, or network
  exposure;
- telemetry, tracing, stored metadata, or privacy boundaries;
- package exports presented as public or experimental; or
- a release whose user impact is not already represented in the public
  changelog.

## Evidence policy

Keep current behavior and qualification status separate.

- Current behavior comes from the implementation and passing deterministic
  tests at the current revision.
- Public qualification comes only from `docs/routekit-l06-evidence.json` and its
  immutable tested revision.
- A deterministic pass does not promote a route when required live or manual
  outcomes are pending.
- Historical reports remain useful evidence but never override the canonical
  durable status.
- Never refresh a version, date, customer, billing, or support claim without the
  evidence that supports it.

## Release checklist

1. Identify product commits since the last meaningful change under
   `apps/docs/content/docs`.
2. Update the source-of-truth matrix rows affected by those commits.
3. Verify every public command example against the freshly built CLI help.
4. Verify model IDs against the registry and all route disclosures against the
   durable evidence JSON.
5. Keep one executable first-success path with prerequisites, expected output,
   and recovery steps.
6. Update both public and maintainer mirrors where a contract is duplicated.
7. Add or strengthen a documentation-contract test for every factual drift bug.
8. Run the validation sequence below and review the built site on desktop and
   mobile.

## Validation

```sh
pnpm check
pnpm build
pnpm test
pnpm docs:build
```

The docs app itself regenerates `apps/docs/public/llms.txt`, validates model
references, compiles Fumadocs MDX, and runs the Next.js build. TypeDoc output is
separate and local-only:

```sh
pnpm docs:generate-code
```

Inspect `/`, `/docs`, installation, commands, configuration, routes and
billing, changelog, search, per-page `.md`, `/llms.txt`, and `/llms-full.txt`.
Confirm navigation, code overflow, diagrams, source/edit actions, and feedback
on both wide and narrow viewports.
