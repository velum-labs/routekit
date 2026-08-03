# @velum-labs/routekit-tools

`packages/tools` publishes `@velum-labs/routekit-tools`: product-neutral coding-tool
launcher, driver, lifecycle, and capability-registry contracts.

## Architecture

This package defines the host/integration boundary used by Codex, Claude Code,
Cursor, and OpenCode adapters. Individual `@velum-labs/routekit-tool-*` packages implement
`ToolIntegration`; hosts assemble immutable registries and supply an opaque
`ToolLaunchSpec`.

## Usage

Use this package when adding a coding-tool integration to a RouteKit host.

```ts
import {
  createToolCapabilityMatrix,
  createToolLaunchContext,
  createToolRegistry
} from "@velum-labs/routekit-tools";
```

`createToolRegistry()` validates and indexes integrations.
`createToolCapabilityMatrix()` compares declared model features across tools.
`createToolLaunchContext()` pairs host lifecycle callbacks and a launch spec
with reverse-order, exactly-once disposer cleanup; `createDisposerRunner()` is
available when a host only needs that cleanup primitive.

## Docs

- CLI and tool integrations: [../../docs/cli.md](../../docs/cli.md)
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
