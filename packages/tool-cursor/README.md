# @velum-labs/routekit-tool-cursor

Product-neutral retained Cursor custom-endpoint setup and canonical ACP driver.

## Architecture

This package remains available as an internal compatibility integration, but
Cursor Desktop and `cursor-agent` are not current RouteKit client-support
surfaces. Cursor Desktop 3.12.30 rejected RouteKit model names before sending a
request to the retained `/v1/cursor` door. RouteKit also does not proxy or
emulate Cursor's backend protocol, so `cursor-agent` cannot use the gateway.

## Usage

Register `cursorTool` in an `@velum-labs/routekit-tools` registry.

```ts
import { cursorTool } from "@velum-labs/routekit-tool-cursor";
```

## Docs

- CLI reference: [../../docs/cli.md](../../docs/cli.md)
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)

## Native client ownership

RouteKit does not track Cursor sessions, and there is no public `routekit
cursor` command. See the
[client compatibility contract](../../docs/routekit-supported-clients.md)
before making any support claim from this internal package.
