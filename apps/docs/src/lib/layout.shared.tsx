import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

function RouteKitMark() {
  return (
    <span className="routekit-brand" aria-label="RouteKit documentation">
      <svg
        className="routekit-mark"
        viewBox="0 0 24 24"
        role="img"
        aria-labelledby="routekit-mark-title"
      >
        <title id="routekit-mark-title">RouteKit route mark</title>
        <path d="M4 4h6v6H4zM14 4h6v6h-6zM9 14h6v6H9z" fill="currentColor" />
        <path d="M7 10v2h5v2M17 10v2h-5" fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <span>RouteKit</span>
      <span className="routekit-brand-docs">DOCS</span>
    </span>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <RouteKitMark />,
      url: "/"
    },
    links: [
      { text: "Guide", url: "/docs/guides/user-guide", active: "nested-url" },
      { text: "Commands", url: "/docs/reference/commands", active: "url" },
      {
        text: "GitHub",
        url: "https://github.com/velum-labs/routekit",
        external: true,
        active: "none"
      }
    ],
    githubUrl: "https://github.com/velum-labs/routekit"
  };
}
