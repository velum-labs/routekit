# RouteKit change intents

This directory is managed by [Changesets](https://github.com/changesets/changesets).

Record release intent alongside a PR:

```bash
pnpm changeset
```

All RouteKit packages are versioned in lockstep through the fixed group in
`config.json`. After changesets reach `main`, `changesets/action` maintains the
Version Packages PR. Merging that PR publishes to npm and creates package tags
and GitHub releases.
