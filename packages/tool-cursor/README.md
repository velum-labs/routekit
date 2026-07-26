# @velum-labs/routekit-tool-cursor

Product-neutral Cursor custom-endpoint setup and canonical ACP driver.

## Architecture

Cursor is supported through its own bring-your-own-key setting: Cursor Settings
-> Models -> Override OpenAI Base URL, pointed at the gateway's `/v1/cursor`
door. RouteKit does not proxy or emulate Cursor's backend protocol, so
`cursor-agent` model calls stay on the logged-in Cursor account.

## Usage

Register `cursorTool` in an `@velum-labs/routekit-tools` registry.

```ts
import { cursorTool } from "@velum-labs/routekit-tool-cursor";
```

## Docs

- Product docs: https://fusionkit.velum-labs.com
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)
