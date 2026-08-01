# RouteKit change intents

This directory is managed by [Changesets](https://github.com/changesets/changesets).

Record release intent alongside a PR:

```bash
pnpm changeset
```

All RouteKit packages are versioned in lockstep through the fixed group in
`config.json`. After changesets reach `main`, `changesets/action` maintains the
Version Packages PR. Merging that PR publishes to npm and creates package tags
and GitHub releases. When the `@velum-labs/routekit@<version>` tag points at the
workflow commit, the same workflow also creates or repairs a completed
`RouteKit <version>` release in the continuous `RouteKit npm` Linear pipeline.
Linear scans the commits since the immediately preceding RouteKit tag and links
their issues without changing issue statuses. The pipeline access key is stored
in the `LINEAR_RELEASE_ACCESS_KEY` GitHub Actions secret.
