"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getSiteUrl } from "@/lib/site-url";

const AGENT_GUIDE_PATH = "/docs/getting-started/agent-guide.md";

function getAgentGuideUrl(currentOrigin?: string): string {
  return new URL(AGENT_GUIDE_PATH, getSiteUrl(currentOrigin)).toString();
}

function buildSetupPrompt(agentGuideUrl: string): string {
  return `Help me install and configure RouteKit by following:
${agentGuideUrl}

Ask which subscriptions or API providers I want to connect. Never request API keys in chat. Finish by verifying \`routekit status\` and \`routekit models list\`, then show me the shortest command to use one discovered model.`;
}

export function AgentSetupPrompt() {
  const [copied, setCopied] = useState(false);
  const [agentGuideUrl, setAgentGuideUrl] = useState(() => getAgentGuideUrl());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setupPrompt = buildSetupPrompt(agentGuideUrl);

  useEffect(() => {
    setAgentGuideUrl(getAgentGuideUrl(window.location.origin));
  }, []);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(setupPrompt);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = setupPrompt;
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
        <p>Paste this into your coding agent.</p>
        <button onClick={copyPrompt} type="button">
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>
      <div className="agent-setup-prompt-body">
        <p>
          Help me install and configure RouteKit by following:
          <br />
          <a href={agentGuideUrl}>{agentGuideUrl}</a>
        </p>
        <p>
          Ask which subscriptions or API providers I want to connect. Never request API
          keys in chat. Finish by verifying <code>routekit status</code> and{" "}
          <code>routekit models list</code>, then show me the shortest command to use one
          discovered model.
        </p>
      </div>
    </div>
  );
}
