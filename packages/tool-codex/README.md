# @velum-labs/routekit-tool-codex

Product-neutral Codex launcher and canonical harness driver.

## Architecture

This package owns the one Codex configuration serializer, launcher, and driver.

## Usage

Register `codexTool` in an `@velum-labs/routekit-tools` registry.

```ts
import { codexTool } from "@velum-labs/routekit-tool-codex";
```

## Docs

- CLI reference: [../../docs/cli.md](../../docs/cli.md)
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)

## Session support

Managed sessions require Codex CLI 0.146.0 or newer. RouteKit starts a private
per-launch app-server, observes the exact `thread/started` UUID, and runs the TUI
against the same Unix socket. New sessions are enrolled durably; `--resume` and
`--continue` target that exact UUID without scans or `--last`.

The launcher uses the normal `CODEX_HOME`, applies gateway routing as process-scoped
configuration, and keeps credentials in the environment. Removal runs supported
`codex delete UUID --force`; metadata is retained if native deletion fails.
