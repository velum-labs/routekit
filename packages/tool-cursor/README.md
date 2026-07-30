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

- CLI reference: [../../docs/cli.md](../../docs/cli.md)
- Maintainer reference: [../../docs/typescript-reference.md](../../docs/typescript-reference.md)

## Session support

RouteKit session enrollment, `--resume`, `--continue`, and removal are unsupported
for Cursor. The public `routekit cursor` command configures BYOK; it does not
launch or supervise a resumable `cursor-agent` session. Explicit gateway use is
therefore not enrolled in RouteKit's session registry.
