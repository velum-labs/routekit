import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { RouteKitMark } from "@/components/routekit-mark";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="routekit-docs-brand">
          <RouteKitMark label="RouteKit documentation" />
          <span className="routekit-brand-docs">DOCS</span>
        </span>
      ),
      url: "/"
    },
    githubUrl: "https://github.com/velum-labs/routekit"
  };
}
