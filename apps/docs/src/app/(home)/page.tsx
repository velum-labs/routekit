import type { Metadata } from "next";
import Link from "next/link";

import { QuickstartTerminal } from "@/components/quickstart-terminal";
import { RouteTrace } from "@/components/route-trace";
import { RECOMMENDED_MODELS } from "@/lib/models";
import { ROUTEKIT_VERSION } from "@/lib/version";

export const metadata: Metadata = {
  title: { absolute: "RouteKit | use your models in your coding tools" },
  description:
    "Pool Codex and Claude Code subscriptions, then use supported models from the coding tools you prefer.",
  openGraph: {
    title: "RouteKit | use your models in your coding tools",
    description:
      "Pool subscriptions and use supported models across Codex, Claude Code, Cursor, and OpenAI-compatible clients.",
    type: "website"
  }
};

const principles = [
  {
    number: "01",
    title: "Use models across tools",
    detail:
      "Run a supported model from Codex, Claude Code, or Cursor. The tool and model do not need to come from the same provider.",
    signal: "routekit claude codex/gpt-5.6-sol"
  },
  {
    number: "02",
    title: "Pool your subscriptions",
    detail:
      "Add more than one Codex or Claude Code account. RouteKit selects from eligible accounts in that provider's pool.",
    signal: "personal + work → one Codex pool"
  },
  {
    number: "03",
    title: "Use it alone or with a team",
    detail:
      "Keep the gateway on your machine, or share one gateway with named, revocable access for each person or client.",
    signal: "one gateway → named access"
  },
  {
    number: "04",
    title: "See what each call used",
    detail:
      "Check the model, provider, subscription or API route, retries, and account chosen for a request.",
    signal: "routekit calls inspect CALL_ID"
  }
] as const;

const qualificationRows = [
  { route: "OpenAI API", path: "OpenAI API key", status: "Tested", tone: "pass" },
  { route: "Anthropic API", path: "Anthropic API key", status: "Tested", tone: "pass" },
  { route: "OpenRouter API", path: "OpenRouter API key", status: "Tested", tone: "pass" },
  { route: "Amazon Bedrock", path: "AWS account and region", status: "Pending", tone: "pending" },
  {
    route: "Codex subscription",
    path: "Codex account pool",
    status: "Needs live account test",
    tone: "blocked"
  },
  {
    route: "Claude Code subscription",
    path: "Claude Code account pool",
    status: "Needs live account test",
    tone: "blocked"
  },
  {
    route: "Cursor custom endpoint",
    path: "RouteKit model route",
    status: "Needs desktop test",
    tone: "blocked"
  }
] as const;

const trustPoints = [
  {
    title: "Keep credentials in one place",
    detail:
      "RouteKit keeps provider credentials and subscription accounts at the gateway instead of copying them into every coding tool."
  },
  {
    title: "Control team access",
    detail:
      "A shared gateway can issue and revoke a named token for each person or client, then attribute calls to that name."
  },
  {
    title: "Telemetry starts off",
    detail:
      "RouteKit sends no product telemetry while it is disabled. DO_NOT_TRACK always takes priority."
  },
  {
    title: "Read the source",
    detail:
      "RouteKit uses the Apache-2.0 license. Its route contract, implementation, and release history are public on GitHub."
  }
] as const;

const footerGroups = [
  {
    label: "EXPLORE",
    links: [
      { href: "/#how-it-works", text: "How it works" },
      { href: "/#routes", text: "What is tested" },
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
  const model = RECOMMENDED_MODELS.codex;

  return (
    <div className="portal-shell">
      <main>
        <section className="portal-hero" aria-labelledby="portal-title">
          <div className="portal-eyebrow">
            <span>OPEN SOURCE MODEL ROUTER</span>
            <span>PRE-1.0 · VERSION {ROUTEKIT_VERSION}</span>
          </div>

          <div className="portal-hero-grid">
            <div className="portal-hero-copy">
              <h1 id="portal-title">
                Your models.
                <br />
                In the tools you <span>already use.</span>
              </h1>
              <p className="portal-lede">
                Pool your Codex and Claude Code subscriptions, then use supported models from Codex,
                Claude Code, Cursor, or an OpenAI-compatible client. Run it on your own machine or
                share one gateway with a team.
              </p>
              <div className="portal-actions">
                <Link className="primary-action" href="/docs/getting-started/installation">
                  INSTALL ROUTEKIT <span aria-hidden="true">↗</span>
                </Link>
                <Link className="secondary-action" href="/#how-it-works">
                  SEE THE EXPERIENCE <span aria-hidden="true">↓</span>
                </Link>
              </div>
              <ul className="portal-evidence-strip" aria-label="RouteKit product attributes">
                <li>Codex + Claude Code pools</li>
                <li>Codex · Claude Code · Cursor</li>
                <li>Personal or shared</li>
              </ul>
            </div>

            <RouteTrace model={model} />
          </div>
        </section>

        <section className="problem-section landing-section" id="how-it-works">
          <div className="section-intro">
            <p className="section-label">TWO THINGS ROUTEKIT DOES</p>
            <h2>Pick your model. Keep your coding tool.</h2>
            <p>
              RouteKit separates the place where you work from the account and model that handle the
              request. That gives you two useful choices.
            </p>
          </div>

          <div className="comparison-board">
            <article>
              <p className="comparison-label">USE MODELS ACROSS TOOLS</p>
              <ul>
                <li>Run a Codex subscription model from Claude Code.</li>
                <li>Use API models from Codex, Claude Code, or Cursor.</li>
                <li>Change the route without rebuilding your coding-tool setup.</li>
              </ul>
            </article>
            <article className="comparison-after">
              <p className="comparison-label">POOL CODEX OR CLAUDE SUBSCRIPTIONS</p>
              <ul>
                <li>Add personal, work, or other accounts by name.</li>
                <li>Choose from eligible accounts with one pool policy.</li>
                <li>See capacity, cooldowns, and the account used for a call.</li>
              </ul>
            </article>
          </div>
        </section>

        <section className="principles-section landing-section" aria-labelledby="principles-title">
          <div className="section-heading">
            <p>BUILT FOR REAL USE</p>
            <h2 id="principles-title">One gateway, with clear controls.</h2>
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
            <p className="section-label">A SHORT EXAMPLE</p>
            <h2 id="onramp-title">Use a Codex pool from Claude Code.</h2>
            <p>
              After installation, these four commands create the config, add two Codex accounts, and
              launch Claude Code with a Codex subscription model. RouteKit selects an eligible
              account from the pool.
            </p>
            <Link className="text-link" href="/docs/getting-started/installation">
              Read the full setup guide <span aria-hidden="true">→</span>
            </Link>
          </div>
          <QuickstartTerminal model={model} />
        </section>

        <section className="routes-section landing-section" id="routes">
          <div className="section-intro routes-intro">
            <p className="section-label">CURRENT SUPPORT</p>
            <h2>What has been tested.</h2>
            <p>
              RouteKit is pre-1.0. OpenAI, Anthropic, and OpenRouter API routes have passed the
              current launch checks. Subscription and Cursor routes still need live account or
              desktop evidence, so test them before production.
            </p>
          </div>

          <div className="qualification-table-wrap">
            <table className="qualification-table">
              <caption>Current public RouteKit L06 qualification evidence</caption>
              <thead>
                <tr>
                  <th scope="col">Route</th>
                  <th scope="col">How it connects</th>
                  <th scope="col">Test status</th>
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
            <p className="release-label">PRE-1.0</p>
            <div>
              <h3 id="release-note-title">Check a route before production.</h3>
              <p>
                The route guide explains where a request goes, what pays for it, and what happens
                when an account runs out of capacity. Provider terms and quotas still apply.
              </p>
            </div>
            <Link href="/docs/reference/routes-and-billing">
              READ THE ROUTE GUIDE <span aria-hidden="true">→</span>
            </Link>
          </aside>
        </section>

        <section className="trust-section landing-section" id="trust">
          <div className="section-heading">
            <p>YOUR GATEWAY</p>
            <h2>What you can control.</h2>
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
          <p className="section-label">TRY IT WITH ONE ROUTE</p>
          <h2 id="close-title">Bring a model into the tool you prefer.</h2>
          <p>
            Install RouteKit, connect one account or API key, and launch a supported coding tool
            with the model you want.
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
          <p>Pool subscriptions and use supported models across coding tools.</p>
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
        <p className="product-footer-meta">Apache-2.0 licensed. Pre-1.0.</p>
      </footer>
    </div>
  );
}
