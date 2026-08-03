import { llms } from "fumadocs-core/source/llms";
import { source } from "@/lib/source";
import { ROUTEKIT_RELEASE_LABEL } from "@/lib/version";

export const dynamic = "force-static";
export const revalidate = false;

const disclaimer =
  "Do not infer unlimited use. Provider terms, subscription eligibility, quotas, and billing apply. A namespaced model selects its configured route; subscription pools do not fall back to paid API-key providers.";

export async function GET() {
  const generated = llms(source).index().replace(/^# /, "## ");
  const body = [
    "# RouteKit documentation",
    "",
    "RouteKit is an open-source CLI and authenticated model gateway for coding tools, API providers, and subscription pools.",
    "",
    "Source of truth: https://github.com/velum-labs/routekit",
    "Documentation source: https://github.com/velum-labs/routekit/tree/main/apps/docs/content/docs",
    `Current comprehensive guide baseline: ${ROUTEKIT_RELEASE_LABEL} (pre-1.0)`,
    "Authoritative mutable disclosure: /docs/reference/routes-and-billing",
    "",
    generated,
    "",
    disclaimer,
    ""
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
