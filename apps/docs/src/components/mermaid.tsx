"use client";

import { useId, useRef, useState } from "react";

let mermaidConfigured = false;

export function Mermaid({ chart, title }: { readonly chart: string; readonly title: string }) {
  const id = `routekit-mermaid-${useId().replaceAll(":", "")}`;
  const chartRef = useRef(chart);
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);

  if (chartRef.current !== chart) chartRef.current = chart;

  function render(node: HTMLDivElement | null) {
    if (!node || svg || failed) return;
    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        if (!mermaidConfigured) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: "dark",
            fontFamily: "var(--font-geist), sans-serif"
          });
          mermaidConfigured = true;
        }
        const rendered = await mermaid.render(id, chartRef.current);
        setSvg(rendered.svg);
      } catch {
        setFailed(true);
      }
    })();
  }

  return (
    <figure className="mermaid-figure" aria-label={title}>
      {svg ? (
        <div
          className="mermaid-diagram"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="mermaid-loading" ref={render} aria-live="polite">
          {failed ? "Diagram unavailable; use the text source below." : "Rendering diagram…"}
        </div>
      )}
      <details className="mermaid-source">
        <summary>Diagram text</summary>
        <pre>
          <code>{chart}</code>
        </pre>
      </details>
    </figure>
  );
}
