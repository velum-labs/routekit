"use client";

import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import type { ComponentProps } from "react";

type QuickstartTerminalProps = {
  readonly model: string;
};

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

export function QuickstartTerminal({ model }: QuickstartTerminalProps) {
  const commands = `curl -fsSL https://github.com/velum-labs/routekit/releases/latest/download/install.sh | sh
export OPENAI_API_KEY='your-key'
routekit config init
routekit start
routekit models info ${model}`;
  const nativeModel = model.split("/").slice(1).join("/");

  return (
    <div
      className="quickstart-terminal"
      aria-label="RouteKit install and route inspection terminal"
    >
      <div className="terminal-bar">
        <span>INSTALL → INSPECT</span>
        <span>COPYABLE SH</span>
      </div>
      <DynamicCodeBlock
        lang="bash"
        code={commands}
        options={{
          themes: { light: "github-dark", dark: "github-dark" },
          components: { pre: TerminalPre }
        }}
      />
      <div className="terminal-result" aria-label="Expected route information">
        <p>EXPECTED ROUTE INFO</p>
        <dl>
          <div>
            <dt>provider</dt>
            <dd>openai</dd>
          </div>
          <div>
            <dt>native model</dt>
            <dd>{nativeModel}</dd>
          </div>
          <div>
            <dt>account class</dt>
            <dd>api-key</dd>
          </div>
          <div>
            <dt>billing mode</dt>
            <dd>metered-api</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
