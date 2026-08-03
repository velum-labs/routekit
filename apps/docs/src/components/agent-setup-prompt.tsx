"use client";

import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";

const SETUP_PROMPT = `Help me install and configure RouteKit by following:
https://routekit-docs-velum-labs.vercel.app/docs/getting-started/agent-guide.md

Ask which subscriptions or API providers I want to connect. Never request API keys in chat. Finish by verifying \`routekit status\` and \`routekit models list\`, then show me the shortest command to use one discovered model.`;

export function AgentSetupPrompt() {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(SETUP_PROMPT);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = SETUP_PROMPT;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setCopied(true);
    timeoutRef.current = setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="agent-setup-prompt">
      <div className="agent-setup-prompt-header">
        <div>
          <span className="agent-setup-prompt-label">AGENT SETUP</span>
          <p>Paste this into your coding agent.</p>
        </div>
        <button onClick={copyPrompt} type="button">
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>
      <pre>
        <code>{SETUP_PROMPT}</code>
      </pre>
    </div>
  );
}
