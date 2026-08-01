import type { Metadata } from "next";
import Link from "next/link";

import { QuickstartTerminal } from "@/components/quickstart-terminal";
import { RouteTrace } from "@/components/route-trace";
import { RECOMMENDED_MODELS } from "@/lib/models";
import { ROUTEKIT_VERSION } from "@/lib/version";

export const metadata: Metadata = {
  title: { absolute: "RouteKit — one gateway, every route explicit" },
  description:
    "Route coding tools and HTTP clients through one authenticated gateway while preserving explicit provider, credential, billing, and failover boundaries.",
  openGraph: {
    title: "RouteKit — one gateway, every route explicit",
    description:
      "An open-source model gateway for explicit provider routes, API keys, and subscription pools.",
    type: "website"
  }
};

const principles = [
  {
    number: "01",
    title: "One stable endpoint",
    detail:
      "Point coding tools and HTTP clients at one bearer-authenticated gateway instead of distributing provider configuration across every client.",
    signal: "http://127.0.0.1:8080"
  },
  {
    number: "02",
    title: "Namespaced by design",
    detail:
      "A provider/model ID stays attached to its provider, native model, account class, and billing mode. Unknown or unnamespaced models fail explicitly.",
    signal: "openai/gpt-5.6-sol"
  },
  {
    number: "03",
    title: "Pools stay in their lane",
    detail:
      "Subscription pools rotate only among eligible accounts of the same kind. Exhaustion never turns into an unexpected paid API route.",
    signal: "codex/* → codex accounts only"
  },
  {
    number: "04",
    title: "Decisions remain inspectable",
    detail:
      "Explain models before a call, then inspect route, billing, retries, usage, principal, and account attribution after it.",
    signal: "routekit calls inspect CALL_ID"
  }
] as const;

const qualificationRows = [
  { route: "OpenAI API", path: "Direct API provider", status: "L06 pass", tone: "pass" },
  { route: "Anthropic API", path: "Direct API provider", status: "L06 pass", tone: "pass" },
  { route: "OpenRouter API", path: "Aggregator API", status: "L06 pass", tone: "pass" },
  { route: "Amazon Bedrock", path: "AWS account + region", status: "L06 pending", tone: "pending" },
  {
    route: "Codex subscription",
    path: "Same-kind account pool",
    status: "Account evidence unavailable",
    tone: "blocked"
  },
  {
    route: "Claude Code subscription",
    path: "Same-kind account pool",
    status: "Account evidence unavailable",
    tone: "blocked"
  },
  {
    route: "Cursor custom endpoint",
    path: "Selected RouteKit route",
    status: "Manual evidence unavailable",
    tone: "blocked"
  }
] as const;

const trustPoints = [
  {
    title: "Local by default",
    detail:
      "Credentials and daemon state live under ROUTEKIT_HOME. Router configuration stays in your user config directory."
  },
  {
    title: "Authenticated at the edge",
    detail:
      "The data gateway requires a bearer token, including when clients share one stable endpoint."
  },
  {
    title: "Telemetry is opt-in",
    detail:
      "No product telemetry client or request is created while disabled. DO_NOT_TRACK always wins."
  },
  {
    title: "Open source",
    detail:
      "RouteKit is Apache-2.0 licensed. Inspect the route contract, implementation, and release history on GitHub."
  }
] as const;

const footerGroups = [
  {
    label: "EXPLORE",
    links: [
      { href: "/#how-it-works", text: "How it works" },
      { href: "/#routes", text: "Route qualification" },
      { href: "/#trust", text: "Privacy & trust" }
    ]
  },
  {
    label: "DEVELOPERS",
    links: [
      { href: "/docs", text: "Documentation" },
      { href: "/docs/reference/commands", text: "Command reference" },
      { href: "/docs/reference/routes-and-billing", text: "Routes & billing" }
    ]
  },
  {
    label: "PROJECT",
    links: [
      { href: "https://github.com/velum-labs/routekit", text: "GitHub" },
      { href: "/docs/changelog", text: "Changelog" },
      {
        href: "https://github.com/velum-labs/routekit/blob/main/LICENSE",
        text: "Apache-2.0 license"
      }
    ]
  }
] as const;

export default function HomePage() {
  const model = RECOMMENDED_MODELS.openai;

  return (
    <div className="portal-shell">
      <main>
        <section className="portal-hero" aria-labelledby="portal-title">
          <div className="portal-eyebrow">
            <span>OPEN-SOURCE MODEL GATEWAY</span>
            <span>PRE-1.0 · VERSION {ROUTEKIT_VERSION}</span>
          </div>

          <div className="portal-hero-grid">
            <div className="portal-hero-copy">
              <h1 id="portal-title">
                One gateway.
                <br />
                Every route <span>explicit.</span>
              </h1>
              <p className="portal-lede">
                Route coding tools and HTTP clients through one authenticated endpoint—without
                silently changing provider, credential owner, billing path, or failover boundary.
              </p>
              <div className="portal-actions">
                <Link className="primary-action" href="/docs/getting-started/installation">
                  INSTALL ROUTEKIT <span aria-hidden="true">↗</span>
                </Link>
                <Link className="secondary-action" href="/#how-it-works">
                  SEE HOW ROUTING WORKS <span aria-hidden="true">↓</span>
                </Link>
              </div>
              <ul className="portal-evidence-strip" aria-label="RouteKit product attributes">
                <li>Bearer authenticated</li>
                <li>Namespaced model IDs</li>
                <li>Apache-2.0</li>
              </ul>
            </div>

            <RouteTrace model={model} />
          </div>
        </section>

        <section className="problem-section landing-section" id="how-it-works">
          <div className="section-intro">
            <p className="section-label">THE CONTROL POINT</p>
            <h2>Your tools should not decide how a model request is routed or billed.</h2>
            <p>
              Coding tools speak slightly different protocols and expect different credentials.
              RouteKit puts one explicit, inspectable boundary between those clients and the
              providers or subscription accounts you choose.
            </p>
          </div>

          <div className="comparison-board">
            <article>
              <p className="comparison-label">WITHOUT A SHARED GATEWAY</p>
              <ul>
                <li>Configure endpoints and model names client by client.</li>
                <li>Repeat provider credentials across development environments.</li>
                <li>Infer where a model name will egress and how it will be billed.</li>
              </ul>
            </article>
            <article className="comparison-after">
              <p className="comparison-label">WITH ROUTEKIT</p>
              <ul>
                <li>Point every supported client at one authenticated URL.</li>
                <li>Keep provider credentials and subscription accounts at the gateway.</li>
                <li>Inspect provider, native model, account class, and billing mode directly.</li>
              </ul>
            </article>
          </div>
        </section>

        <section className="principles-section landing-section" aria-labelledby="principles-title">
          <div className="section-heading">
            <p>THE PRODUCT MODEL</p>
            <h2 id="principles-title">Strict where routing should be strict.</h2>
          </div>
          <div className="principles-grid">
            {principles.map((principle) => (
              <article className="principle" key={principle.number}>
                <span className="principle-number">{principle.number}</span>
                <h3>{principle.title}</h3>
                <p>{principle.detail}</p>
                <code>{principle.signal}</code>
              </article>
            ))}
          </div>
        </section>

        <section className="onramp-section landing-section" aria-labelledby="onramp-title">
          <div className="onramp-copy">
            <p className="section-label">FIRST EXPLAINED ROUTE</p>
            <h2 id="onramp-title">
              Install. Start.
              <br />
              <span>Inspect.</span>
            </h2>
            <p>
              The first useful result is not a glossy dashboard. It is a route you can explain
              before traffic reaches a provider.
            </p>
            <Link className="text-link" href="/docs/getting-started/installation">
              Open the installation guide <span aria-hidden="true">→</span>
            </Link>
          </div>
          <QuickstartTerminal model={model} />
        </section>

        <section className="routes-section landing-section" id="routes">
          <div className="section-intro routes-intro">
            <p className="section-label">PUBLIC QUALIFICATION</p>
            <h2>Current route evidence, without the asterisk hunt.</h2>
            <p>
              RouteKit is pre-1.0. All seven public routes remain planned supported until the L06
              launch gate closes. This is the current evidence state—not a promise of unlimited
              provider or subscription use.
            </p>
          </div>

          <div className="qualification-table-wrap">
            <table className="qualification-table">
              <caption>Current public RouteKit L06 qualification evidence</caption>
              <thead>
                <tr>
                  <th scope="col">Route</th>
                  <th scope="col">Credential / egress path</th>
                  <th scope="col">Current evidence</th>
                </tr>
              </thead>
              <tbody>
                {qualificationRows.map((row) => (
                  <tr key={row.route}>
                    <th scope="row" data-label="Route">
                      {row.route}
                    </th>
                    <td data-label="Path">{row.path}</td>
                    <td data-label="Evidence">
                      <span className={`qualification-status status-${row.tone}`}>
                        <span aria-hidden="true" />
                        {row.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <aside className="release-note" aria-labelledby="release-note-title">
            <p className="release-label">PRE-1.0, EXPLICIT BY DESIGN</p>
            <div>
              <h3 id="release-note-title">Know the boundary before production.</h3>
              <p>
                The public route matrix documents current qualification, billing, egress, failover,
                and limitations. Provider terms, quotas, and eligibility still apply.
              </p>
            </div>
            <Link href="/docs/reference/routes-and-billing">
              REVIEW ROUTES &amp; BILLING <span aria-hidden="true">→</span>
            </Link>
          </aside>
        </section>

        <section className="trust-section landing-section" id="trust">
          <div className="section-heading">
            <p>OPERATIONAL TRUST</p>
            <h2>Control stays visible after the first request.</h2>
          </div>
          <div className="trust-grid">
            {trustPoints.map((point) => (
              <article key={point.title}>
                <span aria-hidden="true">+</span>
                <h3>{point.title}</h3>
                <p>{point.detail}</p>
              </article>
            ))}
          </div>
          <div className="trust-links">
            <Link href="/docs/concepts/privacy">
              Read the privacy model <span aria-hidden="true">→</span>
            </Link>
            <Link href="https://github.com/velum-labs/routekit">
              Inspect the source <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </section>

        <section className="portal-close landing-section" aria-labelledby="close-title">
          <p className="section-label">YOUR FIRST ROUTE</p>
          <h2 id="close-title">
            Install RouteKit.
            <br />
            <span>Know where it goes.</span>
          </h2>
          <p>
            Start the local gateway, inspect a namespaced model, and connect a client when the route
            says exactly what you expect.
          </p>
          <div className="portal-actions portal-close-actions">
            <Link className="primary-action" href="/docs/getting-started/installation">
              INSTALL ROUTEKIT <span aria-hidden="true">↗</span>
            </Link>
            <Link className="secondary-action" href="https://github.com/velum-labs/routekit">
              VIEW ON GITHUB <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </section>
      </main>

      <footer className="product-footer">
        <div className="product-footer-lead">
          <strong>RouteKit</strong>
          <p>One authenticated gateway for explicit model routes.</p>
          <span>VERSION {ROUTEKIT_VERSION} · PRE-1.0</span>
        </div>
        <div className="product-footer-links">
          {footerGroups.map((group) => (
            <div key={group.label}>
              <p>{group.label}</p>
              {group.links.map((link) => (
                <Link href={link.href} key={link.href}>
                  {link.text}
                </Link>
              ))}
            </div>
          ))}
        </div>
        <p className="product-footer-meta">
          Apache-2.0 licensed. RouteKit makes no unlimited-use claim.
        </p>
      </footer>
    </div>
  );
}
