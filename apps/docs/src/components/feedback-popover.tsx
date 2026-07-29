"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

const ISSUE_URL = "https://github.com/velum-labs/routekit/issues/new";
const MAX_QUOTE_LENGTH = 600;

type PopoverState = {
  quote: string;
  x: number;
  y: number;
};

function truncate(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_QUOTE_LENGTH
    ? `${collapsed.slice(0, MAX_QUOTE_LENGTH)}…`
    : collapsed;
}

function buildIssueUrl(quote: string, pageTitle: string, pageUrl: string): string {
  const body = [
    "### Documentation feedback",
    "",
    "**Quoted text**",
    "",
    `> ${quote}`,
    "",
    "**What is wrong or unclear?**",
    "",
    "<!-- Describe the problem here. -->",
    "",
    "---",
    "",
    `Page: [${pageTitle}](${pageUrl})`
  ].join("\n");

  const params = new URLSearchParams({
    title: `Docs feedback: ${pageTitle}`,
    body,
    labels: "documentation"
  });

  return `${ISSUE_URL}?${params.toString()}`;
}

/**
 * Shows a feedback popover when a reader selects text inside the page content.
 *
 * Submitting hands the reader to GitHub with the quoted passage and originating
 * page prefilled, so reporting a documentation problem never requires leaving
 * context to hunt for the right repository or restate what they were reading.
 */
export function FeedbackPopover({ children }: { readonly children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<PopoverState | undefined>();

  const dismiss = useCallback(() => setState(undefined), []);

  useEffect(() => {
    function onSelection() {
      const selection = window.getSelection();
      const container = containerRef.current;
      if (!selection || selection.isCollapsed || !container) {
        setState(undefined);
        return;
      }

      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setState(undefined);
        return;
      }

      const quote = truncate(selection.toString());
      if (quote.length < 3) {
        setState(undefined);
        return;
      }

      const rect = range.getBoundingClientRect();
      setState({
        quote,
        x: rect.left + rect.width / 2 + window.scrollX,
        y: rect.top + window.scrollY
      });
    }

    document.addEventListener("mouseup", onSelection);
    document.addEventListener("keyup", onSelection);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("mouseup", onSelection);
      document.removeEventListener("keyup", onSelection);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [dismiss]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") dismiss();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dismiss]);

  return (
    <div ref={containerRef}>
      {children}
      {state ? (
        <a
          className="feedback-popover"
          style={{ left: `${state.x}px`, top: `${state.y}px` }}
          href={buildIssueUrl(state.quote, document.title, window.location.href)}
          target="_blank"
          rel="noreferrer noopener"
          onClick={dismiss}
        >
          Report an issue with this text
        </a>
      ) : null}
    </div>
  );
}
