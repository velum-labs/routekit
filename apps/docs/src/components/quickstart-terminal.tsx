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
  const commands = `routekit config init
routekit accounts login codex --name personal
routekit accounts login codex --name work
routekit claude ${model}`;
  const nativeModel = model.split("/").slice(1).join("/");

  return (
    <div
      className="quickstart-terminal"
      aria-label="Pool two Codex accounts and use the pool from Claude Code"
    >
      <div className="terminal-bar">
        <span>POOL → RUN</span>
        <span>4 COMMANDS</span>
      </div>
      <DynamicCodeBlock
        lang="bash"
        code={commands}
        options={{
          themes: { light: "github-dark", dark: "github-dark" },
          components: { pre: TerminalPre }
        }}
      />
      <div className="terminal-result" aria-label="What RouteKit uses for this launch">
        <p>WHAT HAPPENS</p>
        <dl>
          <div>
            <dt>coding tool</dt>
            <dd>Claude Code</dd>
          </div>
          <div>
            <dt>model</dt>
            <dd>{nativeModel}</dd>
          </div>
          <div>
            <dt>access</dt>
            <dd>Codex subscription</dd>
          </div>
          <div>
            <dt>account pool</dt>
            <dd>personal + work</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
