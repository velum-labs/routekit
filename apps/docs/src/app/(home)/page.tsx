import bedrockMonoIcon from "@lobehub/icons-static-svg/icons/bedrock.svg";
import bedrockColorIcon from "@lobehub/icons-static-svg/icons/bedrock-color.svg";
import claudeCodeMonoIcon from "@lobehub/icons-static-svg/icons/claudecode.svg";
import claudeCodeColorIcon from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import codexMonoIcon from "@lobehub/icons-static-svg/icons/codex.svg";
import codexColorIcon from "@lobehub/icons-static-svg/icons/codex-color.svg";
import cursorMonoIcon from "@lobehub/icons-static-svg/icons/cursor.svg";
import openAiMonoIcon from "@lobehub/icons-static-svg/icons/openai.svg";
import openRouterMonoIcon from "@lobehub/icons-static-svg/icons/openrouter.svg";
import openRouterColorIcon from "@lobehub/icons-static-svg/icons/openrouter-color.svg";
import type { Metadata } from "next";
import Image, { type StaticImageData } from "next/image";
import Link from "next/link";
import type { CSSProperties } from "react";
import { CopyButton } from "@/components/copy-button";
import { RouteKitMark } from "@/components/routekit-mark";
import { STACKED_BRAND } from "@/lib/brand";
import { RECOMMENDED_MODELS } from "@/lib/models";

export const metadata: Metadata = {
  title: { absolute: "RouteKit | One gateway for your coding subscriptions" },
  description:
    "Use supported models across Codex, Claude Code, Cursor, and OpenAI-compatible clients. Pool subscription accounts and share one reliable gateway."
};

const installCommand =
  "curl -fsSL https://github.com/velum-labs/routekit/releases/latest/download/install.sh | sh";

const MONOCHROME_BRAND_ICONS = true;

type Brand = "bedrock" | "claudeCode" | "codex" | "cursor" | "openai" | "openRouter";

type BrandAssets = {
  readonly color?: StaticImageData | string;
  readonly mono: StaticImageData | string;
};

const brandAssets: Record<Brand, BrandAssets> = {
  bedrock: { color: bedrockColorIcon, mono: bedrockMonoIcon },
  claudeCode: { color: claudeCodeColorIcon, mono: claudeCodeMonoIcon },
  codex: { color: codexColorIcon, mono: codexMonoIcon },
  cursor: { mono: cursorMonoIcon },
  openai: { mono: openAiMonoIcon },
  openRouter: { color: openRouterColorIcon, mono: openRouterMonoIcon }
};

function assetSource(asset: StaticImageData | string) {
  return typeof asset === "string" ? asset : asset.src;
}

type BrandIconProps = {
  readonly brand: Brand;
};

function BrandIcon({ brand }: BrandIconProps) {
  const assets = brandAssets[brand];
  const usesMonochromeAsset = MONOCHROME_BRAND_ICONS || assets.color === undefined;
  return (
    <Image
      alt=""
      aria-hidden="true"
      className={`rk-brand-icon${usesMonochromeAsset ? " rk-brand-icon-monochrome" : ""}`}
      height={24}
      src={usesMonochromeAsset ? assets.mono : assets.color}
      width={24}
    />
  );
}

type InlineBrandProps = {
  readonly brand: Extract<Brand, "claudeCode" | "codex" | "cursor" | "openai">;
  readonly label?: string;
};

const inlineBrands = {
  claudeCode: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  openai: "OpenAI"
} as const;

function InlineBrand({ brand, label }: InlineBrandProps) {
  const assets = brandAssets[brand];
  const usesMonochromeAsset = MONOCHROME_BRAND_ICONS || assets.color === undefined;
  const icon = usesMonochromeAsset ? assets.mono : (assets.color ?? assets.mono);
  const style = {
    "--rk-inline-brand-icon": `url("${assetSource(icon)}")`
  } as CSSProperties;

  return (
    <span
      className={`rk-inline-brand${usesMonochromeAsset ? " rk-inline-brand-monochrome" : ""}`}
      style={style}
    >
      {label ?? inlineBrands[brand]}
    </span>
  );
}

type CopyableCodeProps = {
  readonly value: string;
};

function CopyableCode({ value }: CopyableCodeProps) {
  return (
    <div className="rk-copyable-code">
      <code>{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

const benefits = [
  {
    number: "01",
    label: "CROSS-TOOL ROUTING",
    title: "Pick the model, not the tool.",
    body: (
      <>
        Use a supported model from <InlineBrand brand="codex" />, <InlineBrand brand="claudeCode" />
        , <InlineBrand brand="cursor" />, or any{" "}
        <InlineBrand brand="openai" label="OpenAI-compatible" /> client. RouteKit keeps the endpoint
        stable while you change what runs behind it.
      </>
    ),
    command: `routekit claude ${RECOMMENDED_MODELS.codex}`
  },
  {
    number: "02",
    label: "SUBSCRIPTION POOLS",
    title: "Put your accounts to work together.",
    body: (
      <>
        Connect multiple <InlineBrand brand="codex" /> or <InlineBrand brand="claudeCode" />{" "}
        accounts. RouteKit selects an eligible account from the right pool, so one exhausted account
        does not stop your session.
      </>
    ),
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
    body: (
      <>
        Add an API provider, a <InlineBrand brand="codex" /> account, or a{" "}
        <InlineBrand brand="claudeCode" /> account.
      </>
    )
  },
  {
    number: "2",
    title: "Choose a route",
    body: "Name the provider and model you want. RouteKit handles the qualified path."
  },
  {
    number: "3",
    title: "Open your coding tool",
    body: (
      <>
        Launch <InlineBrand brand="codex" /> or <InlineBrand brand="claudeCode" /> through RouteKit,
        or point <InlineBrand brand="cursor" /> at the gateway.
      </>
    )
  }
] as const;

export default function HomePage() {
  return (
    <main className="rk-landing">
      <section className="rk-hero" aria-labelledby="rk-hero-title">
        <div className="rk-hero-copy">
          <div className="rk-kicker">
            <span>OPEN SOURCE MODEL GATEWAY</span>
          </div>
          <h1 id="rk-hero-title">
            One gateway for your coding <span>subscriptions.</span>
          </h1>
          <p>
            Pool your <InlineBrand brand="codex" /> and <InlineBrand brand="claudeCode" /> accounts
            behind one endpoint. Then use supported models from <InlineBrand brand="codex" />,{" "}
            <InlineBrand brand="claudeCode" />, <InlineBrand brand="cursor" />, or any{" "}
            <InlineBrand brand="openai" label="OpenAI-compatible" /> client.
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

        <div
          className="rk-route-demo"
          aria-label="RouteKit pools Codex and Claude Code accounts and routes their models to supported coding tools"
        >
          <div className="rk-map-stage">
            <div className="rk-map-column rk-map-pools">
              <div className="rk-map-rows">
                <div className="rk-pool-card">
                  <div className="rk-pool-heading">
                    <strong>
                      <BrandIcon brand="codex" />
                      Codex
                    </strong>
                    <span>2 accounts</span>
                  </div>
                  <div className="rk-account-list">
                    <span>
                      <i aria-hidden="true" /> personal
                    </span>
                    <span>
                      <i aria-hidden="true" /> work
                    </span>
                  </div>
                </div>
                <div className="rk-pool-card">
                  <div className="rk-pool-heading">
                    <strong>
                      <BrandIcon brand="claudeCode" />
                      Claude Code
                    </strong>
                    <span>2 accounts</span>
                  </div>
                  <div className="rk-account-list">
                    <span>
                      <i aria-hidden="true" /> personal
                    </span>
                    <span>
                      <i aria-hidden="true" /> team
                    </span>
                  </div>
                </div>
                <div className="rk-provider-row">
                  <span>
                    <BrandIcon brand="bedrock" />
                    Bedrock
                  </span>
                  <span>
                    <BrandIcon brand="openRouter" />
                    OpenRouter
                  </span>
                </div>
              </div>
            </div>

            <span className="rk-map-connector" aria-hidden="true">
              →
            </span>

            <div className="rk-map-core">
              <strong>RouteKit</strong>
            </div>

            <span className="rk-map-connector" aria-hidden="true">
              →
            </span>

            <div className="rk-map-column rk-map-tools">
              <ul className="rk-map-rows">
                <li>
                  <strong>
                    <BrandIcon brand="codex" />
                    Codex
                  </strong>
                </li>
                <li>
                  <strong>
                    <BrandIcon brand="claudeCode" />
                    Claude Code
                  </strong>
                </li>
                <li>
                  <strong>
                    <BrandIcon brand="cursor" />
                    Cursor
                  </strong>
                </li>
              </ul>
            </div>
          </div>
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
              <CopyableCode value={benefit.command} />
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
            <div className="rk-terminal-code">
              <div className="rk-terminal-comment"># Install RouteKit</div>
              <div className="rk-terminal-command">
                <span aria-hidden="true" className="rk-terminal-prompt">
                  $
                </span>
                <code>{installCommand}</code>
                <CopyButton value={installCommand} />
              </div>
              <div className="rk-terminal-comment rk-terminal-comment-spaced">
                # Create a two-account <InlineBrand brand="codex" /> pool
              </div>
              <div className="rk-terminal-command">
                <span aria-hidden="true" className="rk-terminal-prompt">
                  $
                </span>
                <code>routekit accounts login codex --name personal</code>
                <CopyButton value="routekit accounts login codex --name personal" />
              </div>
              <div className="rk-terminal-command">
                <span aria-hidden="true" className="rk-terminal-prompt">
                  $
                </span>
                <code>routekit accounts login codex --name work</code>
                <CopyButton value="routekit accounts login codex --name work" />
              </div>
              <div className="rk-terminal-comment rk-terminal-comment-spaced">
                # Use a <InlineBrand brand="codex" /> model in <InlineBrand brand="claudeCode" />
              </div>
              <div className="rk-terminal-command">
                <span aria-hidden="true" className="rk-terminal-prompt">
                  $
                </span>
                <code>routekit claude {RECOMMENDED_MODELS.codex}</code>
                <CopyButton value={`routekit claude ${RECOMMENDED_MODELS.codex}`} />
              </div>
            </div>
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
          <RouteKitMark surface="dark" variant={STACKED_BRAND ? "stacked" : "inline"} />
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
