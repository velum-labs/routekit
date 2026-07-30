# @velum-labs/routekit-tool-claude

Product-neutral Claude Code launcher and canonical harness driver.

## Architecture

This package owns the one Claude Code profile serializer, launcher, and driver.
It supports exact native session IDs for RouteKit-launched sessions. Claude's
normal session store remains the transcript source of truth and keeps those
sessions visible to Claude's own resume workflow.

## Usage

Register `claudeTool` in an `@velum-labs/routekit-tools` registry.

```ts
import { claudeTool } from "@velum-labs/routekit-tool-claude";
```

## Docs

- CLI reference: [../../docs/cli.md](../../docs/cli.md)
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)

## Session support

`routekit claude --resume <routekit-session-id>` resumes the exact recorded
native Claude session. `routekit claude --continue` deterministically chooses the
newest eligible RouteKit-launched Claude session in the same canonical Git
worktree. Both restore the recorded model, reasoning selection, and gateway target
while obtaining fresh credentials.

RouteKit's registry contains metadata only. It does not parse, copy, import, or
synchronize Claude transcripts. `routekit sessions rm` forgets RouteKit metadata
but cannot delete the native Claude transcript; native visibility and retention
remain Claude-owned. Explicit gateway launches are not enrolled.
