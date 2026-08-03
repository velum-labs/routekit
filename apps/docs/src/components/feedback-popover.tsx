"use client";

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

const ISSUE_URL = "https://github.com/velum-labs/routekit/issues/new";
const MAX_QUOTE_LENGTH = 600;
const MIN_QUOTE_LENGTH = 3;
const EDGE_GUTTER = 8;
const TRIGGER_HALF_WIDTH = 76;
const PANEL_HALF_WIDTH = 176;
/** Viewport headroom each shape needs before it flips below the selection. */
const TRIGGER_HEADROOM = 56;
const PANEL_HEADROOM = 320;
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Anchor = {
  readonly quote: string;
  readonly pageTitle: string;
  readonly pageUrl: string;
  readonly centerX: number;
  readonly topOffset: number;
  readonly bottomOffset: number;
  readonly viewportTop: number;
  readonly containerWidth: number;
};

function truncate(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_QUOTE_LENGTH
    ? `${collapsed.slice(0, MAX_QUOTE_LENGTH)}…`
    : collapsed;
}

function buildIssueUrl(anchor: Anchor, comment: string): string {
  const body = [
    "### Documentation feedback",
    "",
    "**Quoted text**",
    "",
    `> ${anchor.quote}`,
    "",
    "**What is wrong or unclear?**",
    "",
    comment.trim() || "<!-- Describe the problem here. -->",
    "",
    "---",
    "",
    `Page: [${anchor.pageTitle}](${anchor.pageUrl})`
  ].join("\n");

  const params = new URLSearchParams({
    title: `Docs feedback: ${anchor.pageTitle}`,
    body,
    labels: "documentation"
  });

  return `${ISSUE_URL}?${params.toString()}`;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true"
  );
}

/**
 * Offers a feedback panel when a reader selects text inside the page content.
 *
 * Selecting text raises a small trigger; expanding it collects a description
 * alongside the quoted passage and hands the reader to GitHub with both
 * prefilled, so reporting a documentation problem never requires leaving
 * context to hunt for the right repository or restate what they were reading.
 */
export function FeedbackPopover({ children }: { readonly children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  /**
   * Mirrors `expanded` for the document listeners: they are registered once and
   * must see the current shape synchronously, because a stale `false` would let
   * the reader's own clicks and keystrokes inside the panel tear it back down.
   */
  const expandedRef = useRef(false);
  const [anchor, setAnchor] = useState<Anchor | undefined>();
  const [expanded, setExpanded] = useState(false);
  const [comment, setComment] = useState("");
  const commentId = useId();

  const dismiss = useCallback((options: { readonly restoreFocus?: boolean } = {}) => {
    const restoreFocus = options.restoreFocus ?? true;
    const restoreFocusTo = restoreFocusRef.current;
    expandedRef.current = false;
    restoreFocusRef.current = null;
    setAnchor(undefined);
    setExpanded(false);
    setComment("");
    if (restoreFocus) {
      window.setTimeout(() => {
        if (restoreFocusTo?.isConnected) {
          restoreFocusTo.focus({ preventScroll: true });
        } else {
          containerRef.current?.focus({ preventScroll: true });
        }
      }, 0);
    }
  }, []);

  const expand = useCallback(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && !popoverRef.current?.contains(activeElement)) {
      restoreFocusRef.current = activeElement;
    }
    expandedRef.current = true;
    setExpanded(true);
  }, []);

  useEffect(() => {
    function isInsidePopover(target: EventTarget | null): boolean {
      return target instanceof Node && (popoverRef.current?.contains(target) ?? false);
    }

    function onSelection(event: Event) {
      if (expandedRef.current || isInsidePopover(event.target)) return;

      const selection = window.getSelection();
      const container = containerRef.current;
      if (!selection || selection.isCollapsed || !container) {
        setAnchor(undefined);
        return;
      }

      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setAnchor(undefined);
        return;
      }

      const quote = truncate(selection.toString());
      if (quote.length < MIN_QUOTE_LENGTH) {
        setAnchor(undefined);
        return;
      }

      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && !isInsidePopover(activeElement)) {
        restoreFocusRef.current = activeElement;
      }

      const rect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setAnchor({
        quote,
        pageTitle: document.title,
        pageUrl: window.location.href,
        centerX: rect.left + rect.width / 2 - containerRect.left,
        topOffset: rect.top - containerRect.top,
        bottomOffset: rect.bottom - containerRect.top,
        viewportTop: rect.top,
        containerWidth: containerRect.width
      });
    }

    function onPointerDown(event: Event) {
      if (expandedRef.current && !isInsidePopover(event.target)) dismiss({ restoreFocus: false });
    }

    function onScroll() {
      // The popover is positioned within the article, so an open panel keeps
      // tracking the passage it quotes; only the transient trigger is retracted.
      if (!expandedRef.current) setAnchor(undefined);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        dismiss();
        return;
      }

      if (event.key !== "Tab" || !expandedRef.current) return;

      const popover = popoverRef.current;
      if (!popover) return;

      const focusableElements = getFocusableElements(popover);
      if (focusableElements.length === 0) {
        event.preventDefault();
        popover.focus({ preventScroll: true });
        return;
      }

      const activeElement = document.activeElement;
      const activeIndex =
        activeElement instanceof HTMLElement ? focusableElements.indexOf(activeElement) : -1;
      const nextIndex = event.shiftKey
        ? activeIndex <= 0
          ? focusableElements.length - 1
          : activeIndex - 1
        : activeIndex >= focusableElements.length - 1
          ? 0
          : activeIndex + 1;

      if (
        activeIndex === -1 ||
        (event.shiftKey && activeIndex === 0) ||
        (!event.shiftKey && activeIndex === focusableElements.length - 1)
      ) {
        event.preventDefault();
        focusableElements[nextIndex]?.focus({ preventScroll: true });
      }
    }

    document.addEventListener("mouseup", onSelection);
    document.addEventListener("keyup", onSelection);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mouseup", onSelection);
      document.removeEventListener("keyup", onSelection);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [dismiss]);

  useEffect(() => {
    if (expanded) commentRef.current?.focus();
  }, [expanded]);

  let placement: { left: number; top: number; flipped: boolean } | undefined;
  if (anchor) {
    const halfWidth = expanded ? PANEL_HALF_WIDTH : TRIGGER_HALF_WIDTH;
    const center = anchor.containerWidth / 2;
    const slack = Math.max(center - halfWidth - EDGE_GUTTER, 0);
    const flipped = anchor.viewportTop < (expanded ? PANEL_HEADROOM : TRIGGER_HEADROOM);
    placement = {
      left: Math.min(Math.max(anchor.centerX, center - slack), center + slack),
      top: flipped ? anchor.bottomOffset : anchor.topOffset,
      flipped
    };
  }

  return (
    <div ref={containerRef} className="feedback-anchor" tabIndex={-1}>
      {children}
      {anchor && placement ? (
        <div
          ref={popoverRef}
          className={`not-prose feedback-popover${placement.flipped ? " feedback-popover-flipped" : ""}`}
          style={{ left: `${placement.left}px`, top: `${placement.top}px` }}
        >
          {expanded ? (
            <div className="feedback-panel" role="dialog" aria-label="Report a documentation issue">
              <div className="feedback-panel-head">
                <span className="feedback-panel-title">Report an issue</span>
                <button
                  type="button"
                  className="feedback-panel-close"
                  aria-label="Dismiss feedback form"
                  onClick={() => dismiss()}
                >
                  ✕
                </button>
              </div>
              <p className="feedback-panel-quote">{anchor.quote}</p>
              <label className="feedback-panel-label" htmlFor={commentId}>
                What is wrong or unclear?
              </label>
              <textarea
                ref={commentRef}
                id={commentId}
                className="feedback-panel-input"
                rows={3}
                value={comment}
                placeholder="Describe the problem…"
                onChange={(event) => setComment(event.target.value)}
              />
              <a
                className="feedback-panel-send"
                href={buildIssueUrl(anchor, comment)}
                target="_blank"
                rel="noreferrer noopener"
                // Deferred so the browser opens the issue tab while the anchor
                // is still attached; unmounting it inline can cancel the click.
                onClick={() => window.setTimeout(() => dismiss({ restoreFocus: false }), 0)}
              >
                Send
              </a>
            </div>
          ) : (
            <button
              type="button"
              className="feedback-trigger"
              onMouseDown={(event) => event.preventDefault()}
              onClick={expand}
            >
              Report an issue
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
