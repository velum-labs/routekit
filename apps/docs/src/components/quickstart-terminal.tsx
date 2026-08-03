"use client";

import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import type { ComponentProps } from "react";

const QUICKSTART_COMMANDS = `$ curl -fsSL https://github.com/velum-labs/routekit/releases/download/routekit-latest/install.sh | sh
$ routekit setup
$ routekit models list`;

/**
 * The hero sits on a permanently dark panel, so the block keeps the Shiki
 * background in both colour schemes instead of the theme-aware card surface.
 */
function TerminalPre(props: ComponentProps<typeof Pre>) {
  return (
    <CodeBlock {...props} keepBackground>
      <Pre>{props.children}</Pre>
    </CodeBlock>
  );
}

export function QuickstartTerminal() {
  return (
    <div className="quickstart-terminal" aria-label="RouteKit quick start terminal">
      <div className="terminal-bar">
        <span>QUICK START</span>
        <span>SH</span>
      </div>
      <DynamicCodeBlock
        lang="bash"
        code={QUICKSTART_COMMANDS}
        options={{
          themes: { light: "github-dark", dark: "github-dark" },
          components: { pre: TerminalPre }
        }}
      />
    </div>
  );
}
