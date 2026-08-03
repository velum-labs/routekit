"use client";

import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "fumadocs-ui/components/ui/popover";
import { Check, ChevronDown, Copy, FileText } from "lucide-react";
import { useRef, useState } from "react";

type CopyState = "idle" | "copying" | "copied" | "error";

export function PageActions({ markdownUrl }: { readonly markdownUrl: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copyMarkdown() {
    setCopyState("copying");

    try {
      const response = await fetch(markdownUrl);
      if (!response.ok) throw new Error(`Unable to load Markdown (${response.status})`);

      const markdown = await response.text();

      try {
        await navigator.clipboard.writeText(markdown);
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = markdown;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }

      setCopyState("copied");
      setOpen(false);
    } catch {
      setCopyState("error");
    }

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopyState("idle"), 1800);
  }

  const copied = copyState === "copied";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Page Markdown options"
        className="page-action"
        type="button"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <span>{copied ? "Copied" : "Copy page"}</span>
        <ChevronDown aria-hidden="true" className="page-action-chevron" />
      </PopoverTrigger>
      <PopoverContent align="end" className="page-action-menu">
        <a href={markdownUrl} rel="noreferrer" target="_blank">
          <FileText aria-hidden="true" />
          <span>View as Markdown</span>
        </a>
        <button
          disabled={copyState === "copying"}
          onClick={copyMarkdown}
          type="button"
        >
          {copyState === "copied" ? (
            <Check aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
          <span>
            {copyState === "copying"
              ? "Copying…"
              : copyState === "error"
                ? "Couldn’t copy"
                : "Copy as Markdown"}
          </span>
        </button>
      </PopoverContent>
    </Popover>
  );
}
