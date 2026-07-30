# @velum-labs/routekit-tool-claude

Product-neutral Claude Code launcher and canonical harness driver.

## Architecture

This package owns the one Claude Code profile serializer, launcher, and driver.
The native Claude client owns its transcript store and session lifecycle.

## Usage

Register `claudeTool` in an `@velum-labs/routekit-tools` registry.

```ts
import { claudeTool } from "@velum-labs/routekit-tool-claude";
```

## Docs

- CLI reference: [../../docs/cli.md](../../docs/cli.md)
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)

## Native client ownership

RouteKit does not observe, store, resume, or delete Claude sessions. Use Claude's
native history and resume/delete commands directly; launcher arguments after `--`
are forwarded to Claude unchanged.
