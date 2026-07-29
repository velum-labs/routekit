import Link from "next/link";

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
    detail: "Launch Codex, Claude Code, or Cursor against a selected RouteKit model.",
    href: "/docs/guides/user-guide#launch-a-supported-coding-tool",
    action: "CONNECT A TOOL"
  },
  {
    number: "04",
    title: "Consume the HTTP API",
    detail: "Call OpenAI, Anthropic, Codex, and Cursor-compatible endpoints.",
    href: "/docs/guides/user-guide#call-the-http-gateway-directly",
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
    href: "/docs/guides/user-guide#troubleshooting",
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

function ArchitectureDiagram() {
  return (
    <figure className="architecture-figure">
      <svg viewBox="0 0 960 320" role="img" aria-labelledby="architecture-title architecture-desc">
        <title id="architecture-title">RouteKit request flow</title>
        <desc id="architecture-desc">
          Coding tools and HTTP clients send authenticated requests to the RouteKit gateway, which
          routes each namespaced model to an API provider or an eligible member of the matching
          subscription pool.
        </desc>
        <g className="diagram-box">
          <rect x="24" y="38" width="210" height="244" />
          <text x="48" y="72" className="diagram-kicker">
            CLIENTS
          </text>
          <text x="48" y="122">
            Codex
          </text>
          <text x="48" y="162">
            Claude Code
          </text>
          <text x="48" y="202">
            Cursor
          </text>
          <text x="48" y="242">
            HTTP / SDK
          </text>
        </g>
        <g className="diagram-box diagram-core">
          <rect x="370" y="38" width="220" height="244" />
          <text x="394" y="72" className="diagram-kicker">
            AUTHENTICATED
          </text>
          <text x="394" y="132" className="diagram-title">
            RouteKit
          </text>
          <text x="394" y="165">
            gateway + router
          </text>
          <text x="394" y="220" className="diagram-small">
            namespaced model
          </text>
          <text x="394" y="244" className="diagram-small">
            one qualified route
          </text>
        </g>
        <g className="diagram-box">
          <rect x="726" y="38" width="210" height="110" />
          <text x="750" y="72" className="diagram-kicker">
            API ROUTES
          </text>
          <text x="750" y="116">
            Providers
          </text>
          <rect x="726" y="172" width="210" height="110" />
          <text x="750" y="206" className="diagram-kicker">
            SUBSCRIPTIONS
          </text>
          <text x="750" y="250">
            Account pools
          </text>
        </g>
        <g className="diagram-lines">
          <path d="M234 160h136" />
          <path d="M590 160h68V93h68" />
          <path d="M658 160v67h68" />
        </g>
        <g className="diagram-arrow">
          <path d="m358 152 12 8-12 8" />
          <path d="m714 85 12 8-12 8" />
          <path d="m714 219 12 8-12 8" />
        </g>
      </svg>
      <figcaption>
        <strong>Text equivalent.</strong> Clients authenticate to one RouteKit gateway. The
        requested <code>provider/model</code> namespace selects exactly one configured provider.
        Subscription requests choose an eligible account only inside that subscription kind; they do
        not spill into paid API routes.
      </figcaption>
    </figure>
  );
}

export default function HomePage() {
  return (
    <main className="portal-shell">
      <section className="portal-hero" aria-labelledby="portal-title">
        <div className="portal-eyebrow">
          <span>ROUTEKIT DOCUMENTATION</span>
          <span>PRE-1.0 · GUIDE BASELINE 0.16.6</span>
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
                READ THE USER GUIDE
              </Link>
            </div>
          </div>
          <div className="quickstart-terminal" aria-label="RouteKit quick start terminal">
            <div className="terminal-bar">
              <span>QUICK START</span>
              <span>SH</span>
            </div>
            <pre>
              <code>{`$ curl -fsSL https://github.com/velum-labs/routekit/releases/latest/download/install.sh | sh
$ export OPENAI_API_KEY='your-key'
$ routekit config init
$ routekit start
$ routekit models list`}</code>
            </pre>
            <div className="expected-output">
              <span className="status-dot" aria-hidden="true" /> <strong>EXPECTED</strong>
              <span>Gateway ready at http://127.0.0.1:8080 with namespaced models listed.</span>
            </div>
          </div>
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
        <ArchitectureDiagram />
      </section>

      <aside className="release-note" aria-labelledby="release-note-title">
        <span className="release-label">READ BEFORE PRODUCTION</span>
        <div>
          <h2 id="release-note-title">RouteKit is pre-1.0.</h2>
          <p>
            The comprehensive guide documents the 0.16.6 contract. The repository may publish newer
            pre-1.0 builds. Route qualification and billing disclosures are authoritative and can
            change independently of examples. RouteKit does not promise unlimited use; provider and
            subscription terms, quotas, eligibility, and billing still apply.
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
            Complete 0.16.6 user guide <span>→</span>
          </Link>
          <Link href="https://github.com/velum-labs/routekit">
            Source on GitHub <span>↗</span>
          </Link>
        </div>
      </section>
    </main>
  );
}
