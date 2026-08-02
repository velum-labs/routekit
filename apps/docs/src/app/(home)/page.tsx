import type { Metadata } from "next";
import Link from "next/link";
import { RouteKitMark } from "@/components/routekit-mark";
import { RECOMMENDED_MODELS } from "@/lib/models";
import { ROUTEKIT_VERSION } from "@/lib/version";

export const metadata: Metadata = {
  title: { absolute: "RouteKit | One model gateway for your coding tools" },
  description:
    "Use supported models across Codex, Claude Code, Cursor, and OpenAI-compatible clients. Pool subscription accounts and share one reliable gateway."
};

const installCommand =
  "curl -fsSL https://github.com/velum-labs/routekit/releases/latest/download/install.sh | sh";

const benefits = [
  {
    number: "01",
    label: "CROSS-TOOL ROUTING",
    title: "Pick the model, not the tool.",
    body: "Use a supported model from Codex, Claude Code, Cursor, or any OpenAI-compatible client. RouteKit keeps the endpoint stable while you change what runs behind it.",
    command: `routekit claude ${RECOMMENDED_MODELS.codex}`
  },
  {
    number: "02",
    label: "SUBSCRIPTION POOLS",
    title: "Put your accounts to work together.",
    body: "Connect multiple Codex or Claude Code accounts. RouteKit selects an eligible account from the right pool, so one exhausted account does not stop your session.",
    command: "routekit accounts list"
  },
  {
    number: "03",
    label: "PERSONAL OR TEAM",
    title: "Start local. Share when you are ready.",
    body: "Run RouteKit on your machine, or give your team named, revocable access to a shared gateway. Each call stays attributable without sharing one owner token.",
    command: "routekit token issue teammate"
  }
] as const;

const steps = [
  {
    number: "1",
    title: "Connect what you have",
    body: "Add an API provider, a Codex account, or a Claude Code account."
  },
  {
    number: "2",
    title: "Choose a route",
    body: "Name the provider and model you want. RouteKit handles the qualified path."
  },
  {
    number: "3",
    title: "Open your coding tool",
    body: "Launch Codex or Claude Code through RouteKit, or point Cursor at the gateway."
  }
] as const;

export default function HomePage() {
  return (
    <main className="rk-landing">
      <section className="rk-hero" aria-labelledby="rk-hero-title">
        <div className="rk-hero-copy">
          <div className="rk-kicker">
            <span>OPEN SOURCE MODEL GATEWAY</span>
            <span>PRE-1.0</span>
          </div>
          <h1 id="rk-hero-title">
            Your models.
            <br />
            <span>Your coding tools.</span>
          </h1>
          <p>
            RouteKit lets you use supported models across Codex, Claude Code, Cursor, and
            OpenAI-compatible clients. Pool subscription accounts, choose a route, and work in the
            tool you prefer.
          </p>
          <div className="rk-hero-actions">
            <Link className="rk-button rk-button-primary" href="/docs/getting-started/installation">
              Install RouteKit <span aria-hidden="true">↗</span>
            </Link>
            <Link className="rk-button rk-button-secondary" href="/docs">
              Read the docs <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>

        <div className="rk-route-demo" aria-label="Example of a model routed across coding tools">
          <div className="rk-demo-topline">
            <span>LIVE ROUTE</span>
            <span className="rk-status">
              <i aria-hidden="true" /> READY
            </span>
          </div>
          <div className="rk-demo-command">
            <span>$</span> routekit claude {RECOMMENDED_MODELS.codex}
          </div>
          <div className="rk-route-flow">
            <div>
              <small>CODING TOOL</small>
              <strong>Claude Code</strong>
            </div>
            <span className="rk-route-arrow" aria-hidden="true">
              →
            </span>
            <div className="rk-route-core">
              <small>GATEWAY</small>
              <strong>RouteKit</strong>
            </div>
            <span className="rk-route-arrow" aria-hidden="true">
              →
            </span>
            <div>
              <small>MODEL ROUTE</small>
              <strong>{RECOMMENDED_MODELS.codex}</strong>
            </div>
          </div>
          <p>One command. A supported model in a different coding tool.</p>
        </div>
      </section>

      <section className="rk-purple-statement" aria-labelledby="rk-statement-title">
        <p>THE SIMPLE IDEA</p>
        <h2 id="rk-statement-title">Stop tying a model to one coding tool.</h2>
        <div>
          <p>
            Your tools should fit the way you work. RouteKit gives them one place to reach your
            models and subscription accounts.
          </p>
          <Link href="/docs/guides/coding-tools">See supported coding tools →</Link>
        </div>
      </section>

      <section className="rk-benefits" id="why-routekit" aria-labelledby="rk-benefits-title">
        <div className="rk-section-intro">
          <p>WHY ROUTEKIT</p>
          <h2 id="rk-benefits-title">More freedom. Less account juggling.</h2>
        </div>

        <div className="rk-benefit-list">
          {benefits.map((benefit) => (
            <article className="rk-benefit" key={benefit.number}>
              <div className="rk-benefit-number">{benefit.number}</div>
              <div className="rk-benefit-copy">
                <p>{benefit.label}</p>
                <h3>{benefit.title}</h3>
                <span>{benefit.body}</span>
              </div>
              <code>{benefit.command}</code>
            </article>
          ))}
        </div>
      </section>

      <section className="rk-how" id="how-it-works" aria-labelledby="rk-how-title">
        <div className="rk-how-heading">
          <p>HOW IT WORKS</p>
          <h2 id="rk-how-title">From install to first route.</h2>
        </div>

        <div className="rk-how-grid">
          <ol className="rk-steps">
            {steps.map((step) => (
              <li key={step.number}>
                <span>{step.number}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="rk-terminal" aria-label="RouteKit subscription pool setup commands">
            <div className="rk-terminal-bar">
              <span>FIRST ROUTE</span>
              <span>SH</span>
            </div>
            <pre>
              <code>
                <span className="rk-terminal-comment"># Install RouteKit</span>
                {"\n"}
                <span className="rk-terminal-prompt">$</span> {installCommand}
                {"\n\n"}
                <span className="rk-terminal-comment"># Create a two-account Codex pool</span>
                {"\n"}
                <span className="rk-terminal-prompt">$</span> routekit accounts login codex --name
                personal{"\n"}
                <span className="rk-terminal-prompt">$</span> routekit accounts login codex --name
                work{"\n\n"}
                <span className="rk-terminal-comment"># Use a Codex model in Claude Code</span>
                {"\n"}
                <span className="rk-terminal-prompt">$</span> routekit claude{" "}
                {RECOMMENDED_MODELS.codex}
              </code>
            </pre>
          </div>
        </div>
      </section>

      <section className="rk-principles" aria-labelledby="rk-principles-title">
        <div className="rk-section-intro rk-section-intro-light">
          <p>BUILT FOR REAL WORK</p>
          <h2 id="rk-principles-title">A gateway you can understand and control.</h2>
        </div>
        <div className="rk-principle-grid">
          <article>
            <span>LOCAL FIRST</span>
            <h3>Your gateway starts on your machine.</h3>
          </article>
          <article>
            <span>EXPLICIT ROUTES</span>
            <h3>You choose the provider and model.</h3>
          </article>
          <article>
            <span>TEAM ACCESS</span>
            <h3>Named tokens can be revoked and traced.</h3>
          </article>
          <article>
            <span>OPEN SOURCE</span>
            <h3>Inspect it, run it, and shape what comes next.</h3>
          </article>
        </div>
        <p className="rk-version-note">
          RouteKit is pre-1.0. Provider terms, quotas, account eligibility, and billing still apply.
          These docs describe the {ROUTEKIT_VERSION} contract.
        </p>
      </section>

      <section className="rk-final-cta" aria-labelledby="rk-final-title">
        <p>READY WHEN YOU ARE</p>
        <h2 id="rk-final-title">One gateway. Your choice of route.</h2>
        <div>
          <Link className="rk-button rk-button-dark" href="/docs/getting-started/installation">
            Install RouteKit <span aria-hidden="true">↗</span>
          </Link>
          <Link className="rk-cta-text-link" href="/docs/guides/user-guide">
            Explore the guides →
          </Link>
        </div>
      </section>

      <footer className="rk-footer">
        <Link href="/" aria-label="RouteKit home">
          <RouteKitMark surface="dark" />
        </Link>
        <p>Use the models you want in the coding tools you like.</p>
        <nav aria-label="Footer navigation">
          <Link href="/docs">Docs</Link>
          <Link href="https://github.com/velum-labs/routekit">GitHub</Link>
          <Link href="/docs/reference/routes-and-billing">Routes and billing</Link>
        </nav>
      </footer>
    </main>
  );
}
