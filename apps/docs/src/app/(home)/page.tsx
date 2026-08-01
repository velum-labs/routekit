import Link from "next/link";
import { Mermaid } from "@/components/mermaid";
import { QuickstartTerminal } from "@/components/quickstart-terminal";
import { ROUTEKIT_VERSION } from "@/lib/version";

const intents = [
  {
    number: "01",
    title: "Install and reach first success",
    detail: "Install the CLI, initialize a route, and verify the gateway.",
    href: "/docs/getting-started/installation",
    action: "START IN 5 MINUTES"
  },
  {
    number: "02",
    title: "Pool subscription capacity",
    detail: "Enroll Claude Code or Codex accounts and route within one subscription kind.",
    href: "/docs/guides/subscription-pooling",
    action: "BUILD A POOL"
  },
  {
    number: "03",
    title: "Connect coding tools",
    detail: "Launch Codex or Claude Code, or configure Cursor's custom endpoint.",
    href: "/docs/guides/coding-tools",
    action: "CONNECT A TOOL"
  },
  {
    number: "04",
    title: "Consume the HTTP API",
    detail: "Call OpenAI, Anthropic, Codex, and Cursor-compatible endpoints.",
    href: "/docs/guides/http-gateway",
    action: "SEND A REQUEST"
  },
  {
    number: "05",
    title: "Configure routing",
    detail: "Set providers, model aliases, catalog policy, and pool strategy.",
    href: "/docs/reference/configuration",
    action: "CONFIGURE"
  },
  {
    number: "06",
    title: "Run a remote gateway",
    detail: "Provision through SSH, add an HTTPS front door, and enroll clients.",
    href: "/docs/guides/remote-gateway",
    action: "DEPLOY REMOTELY"
  },
  {
    number: "07",
    title: "Inspect and operate",
    detail: "Trace calls, observe quota, diagnose providers, and retain safe rollups.",
    href: "/docs/guides/operations",
    action: "OPERATE"
  },
  {
    number: "08",
    title: "Look up a command",
    detail: "Use the concise CLI reference when you already know the job.",
    href: "/docs/reference/commands",
    action: "OPEN REFERENCE"
  }
] as const;

const architectureChart = `flowchart LR
  Clients["Codex, Claude Code, Cursor BYOK, HTTP clients"]
  Gateway["Authenticated RouteKit gateway and router"]
  Providers["Configured API providers"]
  Pools["Eligible subscription account pools"]
  Clients -->|"authenticated request"| Gateway
  Gateway -->|"provider/model"| Providers
  Gateway -->|"subscription/model"| Pools`;

export default function HomePage() {
  return (
    <main className="portal-shell">
      <section className="portal-hero" aria-labelledby="portal-title">
        <div className="portal-eyebrow">
          <span>ROUTEKIT DOCUMENTATION</span>
          <span>PRE-1.0 · GUIDE BASELINE {ROUTEKIT_VERSION}</span>
        </div>
        <div className="portal-hero-grid">
          <div>
            <h1 id="portal-title">
              One gateway.
              <br />
              <span>Every qualified route.</span>
            </h1>
            <p className="portal-lede">
              Configure providers and subscription accounts once, then give coding tools and HTTP
              clients one stable, authenticated endpoint.
            </p>
            <div className="portal-actions">
              <Link className="primary-action" href="/docs/getting-started/installation">
                INSTALL ROUTEKIT <span>→</span>
              </Link>
              <Link className="secondary-action" href="/docs/guides/user-guide">
                CHOOSE A GUIDE
              </Link>
            </div>
          </div>
          <QuickstartTerminal />
        </div>
      </section>

      <section className="intent-section" aria-labelledby="intent-title">
        <div className="section-heading">
          <p>CHOOSE YOUR PATH</p>
          <h2 id="intent-title">What are you here to do?</h2>
        </div>
        <div className="intent-grid">
          {intents.map((intent) => (
            <Link className="intent-card" href={intent.href} key={intent.number}>
              <span className="intent-number">{intent.number}</span>
              <h3>{intent.title}</h3>
              <p>{intent.detail}</p>
              <span className="intent-action">
                {intent.action} <span aria-hidden="true">↗</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="architecture-section" aria-labelledby="architecture-heading">
        <div className="section-heading">
          <p>MENTAL MODEL</p>
          <h2 id="architecture-heading">A strict route between tools and providers.</h2>
        </div>
        <Mermaid chart={architectureChart} title="RouteKit request flow" />
      </section>

      <aside className="release-note" aria-labelledby="release-note-title">
        <span className="release-label">READ BEFORE PRODUCTION</span>
        <div>
          <h2 id="release-note-title">RouteKit is pre-1.0.</h2>
          <p>
            This documentation set describes the {ROUTEKIT_VERSION} contract. The repository may
            publish newer pre-1.0 builds. Route qualification and billing disclosures are
            authoritative and can change independently of examples. RouteKit does not promise
            unlimited use; provider and subscription terms, quotas, eligibility, and billing still
            apply.
          </p>
        </div>
        <Link href="/docs/reference/routes-and-billing">ROUTES &amp; BILLING →</Link>
      </aside>

      <section className="portal-next">
        <div>
          <p className="section-label">START WITH CONTEXT</p>
          <h2>
            Understand the system,
            <br />
            <span>then ship the route.</span>
          </h2>
        </div>
        <div className="next-links">
          <Link href="/docs">
            Documentation introduction <span>→</span>
          </Link>
          <Link href="/docs/guides/user-guide">
            Task-based {ROUTEKIT_VERSION} user guide <span>→</span>
          </Link>
          <Link href="https://github.com/velum-labs/routekit">
            Source on GitHub <span>↗</span>
          </Link>
        </div>
      </section>
    </main>
  );
}
