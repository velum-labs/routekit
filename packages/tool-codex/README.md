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

## Native client ownership

The launcher uses the user's normal `CODEX_HOME`, applies gateway routing as
process-scoped configuration, and keeps credentials in the environment. RouteKit
does not observe, store, resume, or delete Codex sessions; use Codex's native
history and commands directly.
