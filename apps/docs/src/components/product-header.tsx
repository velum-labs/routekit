import Link from "next/link";

import { RouteKitMark } from "@/components/routekit-mark";

const navigation = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#routes", label: "What's tested" },
  { href: "/#trust", label: "Privacy & trust" },
  { href: "/docs", label: "Docs" },
  { href: "https://github.com/velum-labs/routekit", label: "GitHub" }
] as const;

export function ProductHeader() {
  return (
    <header className="product-header">
      <div className="product-header-inner">
        <Link className="product-brand-link" href="/">
          <RouteKitMark label="RouteKit home" surface="dark" />
        </Link>

        <nav className="product-navigation" aria-label="Product navigation">
          {navigation.map((item) => (
            <Link href={item.href} key={item.href}>
              {item.label}
            </Link>
          ))}
          <Link className="product-nav-action" href="/docs/getting-started/installation">
            Install <span aria-hidden="true">↗</span>
          </Link>
        </nav>

        <details className="product-mobile-navigation">
          <summary>
            <span>Menu</span>
            <span className="product-menu-mark" aria-hidden="true">
              +
            </span>
          </summary>
          <nav aria-label="Mobile product navigation">
            {navigation.map((item) => (
              <Link href={item.href} key={item.href}>
                {item.label}
              </Link>
            ))}
            <Link className="product-nav-action" href="/docs/getting-started/installation">
              Install RouteKit <span aria-hidden="true">↗</span>
            </Link>
          </nav>
        </details>
      </div>
    </header>
  );
}
